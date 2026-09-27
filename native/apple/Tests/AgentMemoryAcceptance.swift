import AppKit

/// The writing assistant's memory and long work through the real 写作助手
/// panel, controller, tab host and Rust workspace: 作者规则, 工作记忆, 任务计划
/// with 继续, compaction, retries, usage, assistant authorship and one-original
/// element creation. Providers are stubbed with synthetic streams and keys
/// are synthetic; nothing reaches a real provider.
extension BindingAcceptance {
    static func agentMemoryAcceptance() throws -> [String] {
        try memoryRules()
        try memoryWorkingMemory()
        try memoryTaskPlan()
        try memoryCompaction()
        try memoryRetries()
        try memoryUsage()
        try memoryAuthorship()
        return [
            "AppKit 作者规则 are added, edited, refused and deleted in the 写作助手 panel and created, listed, updated and deleted by the model's rule tools without proposals; each tool change shows a 已记住 card whose 撤销 reverts it and is told to the model once, rules enter every request's system prompt, persist in author-rules.json beside the conversations through a relaunch and never reach the journal, SQLite or user defaults",
            "AppKit 工作记忆 is read, replaced and bounded by the model's tools with a Chinese refusal over 6,000 characters, enters the system prompt, shows in its collapsible panel section, is edited and cleared by the author after confirmation and persists in the conversation file",
            "AppKit 任务计划 tools set a goal, ordered steps with 待办/进行中/完成/跳过, notes and constraints shown as a checklist and refuse a missing plan or step; when the 24-round limit stops a turn with unfinished steps 继续 appears, nothing continues on its own, and 继续 starts a new turn that carries the plan",
            "AppKit compaction above 70% of a synthetic context window summarises older turns with the same provider without streaming or tools, keeps recent turns verbatim behind a 已压缩较早的对话 marker and keeps pending proposals and their outcomes, and a failed or timed-out summary falls back to a deterministic trim that keeps the rules, working memory, plan and recent turns",
            "AppKit retries HTTP 429 after its Retry-After, 503 and a dropped connection up to three times showing 重试中（n/3）, never retries 401, stops during the backoff on 停止, and a retried tool call makes exactly one proposal",
            "AppKit usage records input, cached and output tokens from DeepSeek, Anthropic and OpenAI usage fields, and unknown when a provider sends none, in the conversation file; 设置 › 写作助手 › 用量 totals today and 30 days by provider and model and per conversation, and deleting a conversation after confirmation removes its usage",
            "AppKit an accepted create_comment is stored as 写作助手 (author kind ai), its 审阅 card says so and stays editable, and create_element writes name, group, summary, aliases and facts in one original so a refused alias leaves nothing written",
        ]
    }

    // MARK: Helpers

    private static func memoryArguments(_ value: [String: Any]) -> String { AgentJSONText.encode(value) }

    private static func memoryResults(_ harness: AgentHarness) -> [String: AgentMessage] {
        Dictionary(harness.conversation.messages.filter { $0.role == .tool }.compactMap { message in message.callID.map { ($0, message) } },
                   uniquingKeysWith: { _, last in last })
    }

    private static func memoryJSON(_ message: AgentMessage?) -> [String: Any] { message.flatMap { AgentJSONText.object($0.text) } ?? [:] }

    /// The system prompt a captured DeepSeek request sent.
    private static func memorySystem(_ body: [String: Any]) -> String {
        ((body["messages"] as? [[String: Any]])?.first { $0["role"] as? String == "system" }?["content"] as? String) ?? ""
    }

    /// The provider-facing messages after the system prompt.
    private static func memoryMessages(_ body: [String: Any]) -> [[String: Any]] {
        ((body["messages"] as? [[String: Any]]) ?? []).filter { $0["role"] as? String != "system" }
    }

    private static func memoryFind(_ identifier: String, in view: NSView) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for child in view.subviews { if let found = memoryFind(identifier, in: child) { return found } }
        return nil
    }

    private static func pump(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
    }

    /// Presses 发送 without waiting for the turn.
    private static func memoryStart(_ harness: AgentHarness, _ text: String) throws {
        harness.panel.composer.string = text
        harness.panel.composer.didChangeText()
        harness.panel.sendButton.performClick(nil)
        try require(harness.controller.isRunning, "The panel did not send \(text)")
    }

    /// One tool round, then a short answer.
    private static func memoryTurn(_ harness: AgentHarness, _ calls: [(id: String, name: String, arguments: String)], _ text: String,
                                   answer: String = "好。") throws {
        let notices = harness.controller.current == nil ? 0 : harness.notices.count
        AgentStubProtocol.reset([AgentSSE.deepseekTools(calls), AgentSSE.deepseekText([answer])])
        try harness.send(text)
        try require(harness.notices.count == notices, "The turn \(text) ended with a notice: \(harness.notices)")
    }

    private static func memoryAccept(_ harness: AgentHarness, _ id: String) throws {
        guard let card = harness.card(id), card.acceptButton.isEnabled else { throw LabError.message("\(id) has no pending card") }
        card.acceptButton.performClick(nil)
        try wait { harness.proposal(id)?.state != .applying && harness.proposal(id)?.state != .pending }
        try wait { harness.host.canNavigate && !harness.host.isBusy }
    }

    /// The text of every file under a directory, for proving where data is not.
    private static func filesContain(_ directory: URL, _ needle: String) -> [String] {
        let bytes = Data(needle.utf8)
        guard let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil) else { return [] }
        return files.compactMap { $0 as? URL }.filter { url in
            guard let data = try? Data(contentsOf: url) else { return false }
            return data.range(of: bytes) != nil
        }.map(\.lastPathComponent)
    }

    // MARK: (a) 作者规则

    private static func memoryRules() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let journal = JournalProbe(directory: harness.directory)
        let mark = try journal.mark()
        let panel = harness.panel!, sections = panel.memorySections
        func answerRule(_ title: String, kind: Int, text: String) {
            harness.answer = { alert in
                guard alert.messageText == title, let form = alert.accessoryView else { return .alertSecondButtonReturn }
                (memoryFind("agent-rule-kind", in: form) as? NSPopUpButton)?.selectItem(at: kind)
                (memoryFind("agent-rule-field", in: form) as? NSTextField)?.stringValue = text
                return .alertFirstButtonReturn
            }
        }
        try require(sections.rules.title == "作者规则" && panel.element("agent-rules-empty") != nil, "The empty rules section differs")

        // 添加… from the panel.
        answerRule("添加作者规则", kind: 0, text: "  对话少用感叹号。\n  ")
        sections.addRuleButton.performClick(nil)
        var rules = harness.controller.rules
        try require(rules.count == 1 && rules[0].kind == .preference && rules[0].text == "对话少用感叹号。" && rules[0].source == "author",
            "The panel did not add the rule: \(rules)")
        let authorRule = rules[0]
        try require((panel.element("agent-rule-text-\(authorRule.id)") as? NSTextField)?.stringValue == "【偏好】对话少用感叹号。"
            && sections.rules.title == "作者规则（1）", "The rule row differs")
        // A blank rule is refused and nothing is stored.
        answerRule("添加作者规则", kind: 0, text: "   ")
        sections.addRuleButton.performClick(nil)
        try require(harness.controller.rules.count == 1 && !sections.ruleMessage.isHidden && sections.ruleMessage.stringValue == "规则内容不能为空。",
            "A blank rule was not refused: \(sections.ruleMessage.stringValue)")
        // 编辑… changes the kind and the words.
        answerRule("编辑作者规则", kind: 2, text: "对话里不用感叹号。")
        (panel.element("agent-rule-edit-\(authorRule.id)") as? NSButton)?.performClick(nil)
        rules = harness.controller.rules
        try require(rules.count == 1 && rules[0].id == authorRule.id && rules[0].kind == .directive && rules[0].text == "对话里不用感叹号。"
            && sections.ruleMessage.isHidden && (panel.element("agent-rule-text-\(authorRule.id)") as? NSTextField)?.stringValue == "【指令】对话里不用感叹号。",
            "The rule was not edited: \(rules)")
        // 删除 asks first.
        answerRule("添加作者规则", kind: 0, text: "章节标题用两个字。")
        sections.addRuleButton.performClick(nil)
        let second = harness.controller.rules[1]
        harness.answer = { _ in .alertSecondButtonReturn }
        (panel.element("agent-rule-delete-\(second.id)") as? NSButton)?.performClick(nil)
        try require(harness.controller.rules.count == 2, "取消 deleted the rule")
        harness.answer = { alert in alert.messageText == "删除这条作者规则？" && alert.informativeText == "【偏好】章节标题用两个字。" ? .alertFirstButtonReturn : .alertSecondButtonReturn }
        (panel.element("agent-rule-delete-\(second.id)") as? NSButton)?.performClick(nil)
        try require(harness.controller.rules.map(\.id) == [authorRule.id] && panel.element("agent-rule-\(second.id)") == nil, "删除 did not remove the rule")

        // The model's rule tools apply at once without proposals.
        AgentStubProtocol.reset([
            AgentSSE.deepseekTools([
                ("call_rule_new", "create_author_rule", memoryArguments(["kind": "veto", "text": "不要让林岚在雨夜哭泣。"])),
                ("call_rule_list", "list_author_rules", "{}"),
                ("call_rule_blank", "create_author_rule", memoryArguments(["kind": "preference", "text": " "])),
                ("call_rule_kind", "create_author_rule", memoryArguments(["kind": "wish", "text": "x"])),
                ("call_rule_update", "update_author_rule", memoryArguments(["ruleId": authorRule.id, "text": "对话里一律不用感叹号。"])),
                ("call_rule_missing", "delete_author_rule", memoryArguments(["ruleId": "rule-missing"])),
            ]),
            AgentSSE.deepseekText(["记住了。"]),
        ])
        try harness.send("以后不要让林岚在雨夜哭泣，对话里一律不用感叹号。")
        let first = memorySystem(AgentStubProtocol.requests[0].body), after = memorySystem(AgentStubProtocol.requests[1].body)
        try require(first.contains("【作者规则】") && first.contains("【指令】对话里不用感叹号。（编号 \(authorRule.id)）") && !first.contains("雨夜哭泣"),
            "The first request lacks the author's rule: \(first)")
        try require(after.contains("【否决】不要让林岚在雨夜哭泣。") && after.contains("【指令】对话里一律不用感叹号。"),
            "The next request lacks the changed rules")
        let found = memoryResults(harness)
        let listed = (memoryJSON(found["call_rule_list"])["rules"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
        try require(found["call_rule_new"]?.ok == true && listed == ["对话里不用感叹号。", "不要让林岚在雨夜哭泣。"]
            && found["call_rule_blank"]?.text == "规则内容不能为空。"
            && found["call_rule_kind"]?.text.hasPrefix("参数 kind 必须是以下之一：preference、veto、directive。") == true
            && found["call_rule_update"]?.ok == true
            && found["call_rule_missing"]?.text.contains("找不到编号为 rule-missing 的作者规则") == true,
            "Rule tool results differ: \(found.mapValues(\.text))")
        try require(harness.conversation.proposals.isEmpty, "A rule tool made a proposal")
        rules = harness.controller.rules
        let veto = rules.first { $0.kind == .veto }
        try require(rules.count == 2 && rules[0].text == "对话里一律不用感叹号。" && rules[0].source == "assistant"
            && veto?.text == "不要让林岚在雨夜哭泣。" && veto?.source == "assistant", "Rules after the tools differ: \(rules)")
        guard let createdRow = found["call_rule_new"], let updatedRow = found["call_rule_update"],
              let createdCard = panel.element("agent-memory-\(createdRow.id)") as? AgentMemoryCard,
              let updatedCard = panel.element("agent-memory-\(updatedRow.id)") as? AgentMemoryCard else {
            throw LabError.message("Rule tools did not show memory cards")
        }
        try require(createdCard.label.stringValue == "已记住：【否决】不要让林岚在雨夜哭泣。" && !createdCard.undoButton.isHidden
            && updatedCard.label.stringValue == "已更新记忆：【指令】对话里一律不用感叹号。"
            && panel.transcriptTexts.contains("已记住：【否决】不要让林岚在雨夜哭泣。")
            && panel.element("agent-rule-text-\(veto!.id)") != nil, "The memory cards differ: \(panel.transcriptTexts)")
        // The file beside the conversations holds them.
        harness.controller.store.flush()
        let file = harness.controller.store.directory.appendingPathComponent(AgentConversationStore.rulesFile)
        let stored = try AgentConversationStore.decoder().decode(AgentAuthorRulesFile.self, from: Data(contentsOf: file))
        try require(stored.rules.map(\.id) == rules.map(\.id) && stored.rules.map(\.text) == rules.map(\.text), "author-rules.json differs")

        // 撤销 reverts each change and the next turn tells the model once.
        createdCard.undoButton.performClick(nil)
        (panel.element("agent-memory-undo-\(updatedRow.id)") as? NSButton)?.performClick(nil)
        rules = harness.controller.rules
        try require(rules.map(\.text) == ["对话里不用感叹号。"] && rules[0].kind == .directive, "撤销 did not revert the rules: \(rules)")
        let undoneCard = panel.element("agent-memory-\(createdRow.id)") as? AgentMemoryCard
        try require(undoneCard?.label.stringValue == "已撤销记住：【否决】不要让林岚在雨夜哭泣。" && undoneCard?.undoButton.isHidden == true,
            "The undone card differs")
        AgentStubProtocol.reset([AgentSSE.deepseekText(["明白。"]), AgentSSE.deepseekText(["好。"])])
        try harness.send("刚才的规则我撤销了。")
        let told = AgentHarness.lastUserText(AgentStubProtocol.requests[0].body)
        try require(told.contains("作者撤销了你对作者规则的修改") && told.contains("作者撤销了你刚记住的规则 \(veto!.id)")
            && told.contains("恢复为【指令】对话里不用感叹号。") && !memorySystem(AgentStubProtocol.requests[0].body).contains("雨夜哭泣"),
            "The undo was not told: \(told)")
        try harness.send("还有吗？")
        try require(!AgentHarness.lastUserText(AgentStubProtocol.requests[1].body).contains("撤销"), "The undo was told twice")

        // A tool deletes the author's rule; 撤销 brings it back.
        try memoryTurn(harness, [("call_rule_forget", "delete_author_rule", memoryArguments(["ruleId": authorRule.id]))], "忘掉感叹号那条。")
        guard let forgetRow = memoryResults(harness)["call_rule_forget"],
              let forgetCard = panel.element("agent-memory-\(forgetRow.id)") as? AgentMemoryCard else { throw LabError.message("No card for the deletion") }
        try require(harness.controller.rules.isEmpty && forgetCard.label.stringValue == "已忘记：【指令】对话里不用感叹号。", "The tool did not delete the rule")
        forgetCard.undoButton.performClick(nil)
        try require(harness.controller.rules.map(\.id) == [authorRule.id], "撤销 did not restore the deleted rule")

        // A relaunch reads the same rules and cards.
        let before = harness.controller.rules
        harness.controller.store.flush()
        harness.reopenPanel()
        let reopened = harness.controller.rules
        try require(reopened.map(\.id) == before.map(\.id) && reopened.map(\.text) == before.map(\.text) && reopened.map(\.kind) == before.map(\.kind)
            && harness.panel.element("agent-rule-\(authorRule.id)") != nil, "Rules did not survive a relaunch")
        let reopenedCard = harness.panel.element("agent-memory-\(createdRow.id)") as? AgentMemoryCard
        try require(reopenedCard?.undoButton.isHidden == true && reopenedCard?.label.stringValue.hasPrefix("已撤销记住") == true,
            "The undone card did not survive a relaunch")
        // Memory, not canon: no journal row, no SQLite byte, no user default.
        try require((try journal.originals(since: mark)).isEmpty, "A rule reached the journal")
        for text in ["对话里不用感叹号", "不要让林岚在雨夜哭泣", "章节标题用两个字"] {
            try require(filesContain(harness.directory, text).isEmpty, "A rule reached the lab workspace: \(filesContain(harness.directory, text))")
            try require(!"\(UserDefaults.standard.dictionaryRepresentation())".contains(text), "A rule reached user defaults")
        }
        try harness.close()
    }

    // MARK: (b) 工作记忆

    private static func memoryWorkingMemory() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let journal = JournalProbe(directory: harness.directory)
        let mark = try journal.mark()
        let panel = harness.panel!, sections = panel.memorySections
        let note = "## 进度\n- 已读《启程》\n\n## 下一步\n- 改写结尾"
        let long = String(repeating: "长", count: AgentWorkingMemory.limit + 1)
        try memoryTurn(harness, [
            ("call_wm_empty", "read_working_memory", "{}"),
            ("call_wm_save", "checkpoint_working_memory", memoryArguments(["text": "\n" + note + "\n\n"])),
            ("call_wm_long", "checkpoint_working_memory", memoryArguments(["text": long])),
            ("call_wm_read", "read_working_memory", "{}"),
        ], "记一下进度。")
        let found = memoryResults(harness)
        try require(memoryJSON(found["call_wm_empty"])["note"] as? String == "工作记忆是空的。" && found["call_wm_save"]?.ok == true
            && found["call_wm_long"]?.ok == false && found["call_wm_long"]?.text.hasPrefix("工作记忆最多 6000 字，这次有 6001 字。") == true
            && memoryJSON(found["call_wm_read"])["text"] as? String == note && memoryJSON(found["call_wm_read"])["updatedBy"] as? String == "写作助手",
            "Working memory tools differ: \(found.mapValues(\.text))")
        try require(harness.conversation.workingMemory == note && harness.conversation.workingMemoryUpdatedBy == "assistant"
            && harness.conversation.proposals.isEmpty, "The note was not stored")
        let system = memorySystem(AgentStubProtocol.requests[1].body)
        try require(system.contains("【工作记忆】") && system.contains("- 改写结尾"), "The next request lacks the working memory")
        try require(sections.memory.title == "工作记忆（\(note.count) 字）" && (panel.element("agent-memory-text") as? NSTextField)?.stringValue == note
            && (panel.element("agent-memory-updated") as? NSTextField)?.stringValue == "上次由写作助手更新" && !sections.memory.isExpanded,
            "The collapsed section differs: \(sections.memory.title)")
        sections.memory.toggle.performClick(nil)
        try require(sections.memory.isExpanded, "The section did not expand")

        // The author edits it; over the limit is refused.
        func answerEdit(_ text: String) {
            harness.answer = { alert in
                guard alert.messageText == "编辑工作记忆", let editor = alert.accessoryView.flatMap({ memoryFind("agent-memory-editor", in: $0) }) as? NSTextView else {
                    return .alertSecondButtonReturn
                }
                editor.string = text
                return .alertFirstButtonReturn
            }
        }
        answerEdit("## 进度\n- 结尾已改写")
        sections.editMemoryButton.performClick(nil)
        try require(harness.conversation.workingMemory == "## 进度\n- 结尾已改写" && harness.conversation.workingMemoryUpdatedBy == "author"
            && (panel.element("agent-memory-updated") as? NSTextField)?.stringValue == "上次由你编辑" && sections.memoryMessage.isHidden,
            "The author's edit was not stored")
        answerEdit(long)
        sections.editMemoryButton.performClick(nil)
        try require(harness.conversation.workingMemory == "## 进度\n- 结尾已改写" && !sections.memoryMessage.isHidden
            && sections.memoryMessage.stringValue.hasPrefix("工作记忆最多 6000 字"), "An oversized edit was not refused")
        AgentStubProtocol.reset([AgentSSE.deepseekText(["收到。"])])
        try harness.send("看一下笔记。")
        try require(memorySystem(AgentStubProtocol.requests[0].body).contains("- 结尾已改写"), "The author's note did not reach the model")
        // The conversation file holds it through a relaunch.
        harness.controller.store.flush()
        let file = harness.controller.store.directory.appendingPathComponent("\(harness.conversation.id).json")
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        try require(saved?["workingMemory"] as? String == "## 进度\n- 结尾已改写" && saved?["workingMemoryUpdatedBy"] as? String == "author",
            "The conversation file lacks the working memory")
        harness.reopenPanel()
        try require(harness.conversation.workingMemory == "## 进度\n- 结尾已改写"
            && (harness.panel.element("agent-memory-text") as? NSTextField)?.stringValue == "## 进度\n- 结尾已改写", "The note did not survive a relaunch")
        // 清空 asks first.
        let fresh = harness.panel.memorySections
        harness.answer = { _ in .alertSecondButtonReturn }
        fresh.clearMemoryButton.performClick(nil)
        try require(!harness.conversation.workingMemory.isEmpty, "取消 cleared the note")
        harness.answer = { alert in alert.messageText == "清空本对话的工作记忆？" ? .alertFirstButtonReturn : .alertSecondButtonReturn }
        fresh.clearMemoryButton.performClick(nil)
        try require(harness.conversation.workingMemory.isEmpty && fresh.memory.title == "工作记忆（空）" && !fresh.clearMemoryButton.isEnabled,
            "清空 did not clear the note")
        AgentStubProtocol.reset([AgentSSE.deepseekText(["好。"])])
        try harness.send("继续写。")
        try require(!memorySystem(AgentStubProtocol.requests[0].body).contains("【工作记忆】"), "A cleared note still reached the model")
        try require((try journal.originals(since: mark)).isEmpty, "Working memory reached the journal")
        try harness.close()
    }

    // MARK: (c) 任务计划 and 继续

    private static func memoryTaskPlan() throws {
        let harness = try AgentHarness(titles: ["启程", "航行"])
        defer { harness.remove() }
        let panel = harness.panel!, sections = panel.memorySections
        try require(sections.plan.isHidden, "A plan section showed without a plan")
        let steps = ["读《启程》", "写《启程》的摘要", "读《航行》", "写《航行》的摘要"]
        try memoryTurn(harness, [
            ("call_step_none", "update_task_step", memoryArguments(["step": 1, "status": "done"])),
            ("call_plan", "update_task_plan", memoryArguments(["goal": "给前两章各写一段摘要", "steps": steps])),
            ("call_constraint", "update_task_constraint", memoryArguments(["operation": "add", "text": "摘要不超过五十字"])),
            ("call_constraint_bad", "update_task_constraint", memoryArguments(["operation": "remove", "constraintId": "c9"])),
            ("call_step_1", "update_task_step", memoryArguments(["step": 1, "status": "done", "note": "已读"])),
            ("call_step_2", "update_task_step", memoryArguments(["step": 2, "status": "in_progress"])),
            ("call_step_9", "update_task_step", memoryArguments(["step": 9, "status": "done"])),
            ("call_step_zero", "update_task_step", memoryArguments(["step": 0, "status": "done"])),
            ("call_step_half", "update_task_step", memoryArguments(["step": 1.5, "status": "done"])),
            ("call_step_status", "update_task_step", memoryArguments(["step": 1, "status": "finished"])),
            ("call_plan_read", "read_task_plan", "{}"),
        ], "给前两章各写一段摘要。")
        let found = memoryResults(harness)
        try require(found["call_step_none"]?.text.hasPrefix("本对话还没有任务计划") == true && found["call_plan"]?.ok == true
            && found["call_constraint"]?.ok == true && found["call_constraint_bad"]?.text.contains("找不到编号为 c9 的限制") == true
            && found["call_step_9"]?.text == "任务计划只有 4 步，没有第 9 步。"
            && found["call_step_zero"]?.text.hasPrefix("参数 step 不能小于 1。") == true
            && found["call_step_half"]?.text.hasPrefix("参数 step 必须是整数。") == true
            && found["call_step_status"]?.text.hasPrefix("参数 status 必须是以下之一：todo、in_progress、done、skipped。") == true,
            "Plan tool results differ: \(found.mapValues(\.text))")
        let read = memoryJSON(found["call_plan_read"])["plan"] as? [String: Any] ?? [:]
        let readSteps = read["steps"] as? [[String: Any]] ?? []
        try require(read["goal"] as? String == "给前两章各写一段摘要" && readSteps.compactMap { $0["status"] as? String } == ["done", "in_progress", "todo", "todo"]
            && readSteps.first?["note"] as? String == "已读" && read["unfinished"] as? Int == 3
            && (read["constraints"] as? [[String: Any]])?.first?["constraintId"] as? String == "c1", "read_task_plan differs: \(read)")
        guard let plan = harness.conversation.plan else { throw LabError.message("The plan was not stored") }
        try require(plan.steps.map(\.title) == steps && plan.steps.map(\.status) == [.done, .inProgress, .todo, .todo]
            && plan.constraints.map(\.text) == ["摘要不超过五十字"] && harness.conversation.proposals.isEmpty, "The stored plan differs")
        try require(!sections.plan.isHidden && sections.plan.isExpanded && sections.plan.title == "任务计划（1/4 完成）"
            && sections.planLines == ["目标：给前两章各写一段摘要", "✓ 1. 读《启程》（已读）", "◐ 2. 写《启程》的摘要", "○ 3. 读《航行》", "○ 4. 写《航行》的摘要",
                                      "限制：摘要不超过五十字"], "The checklist differs: \(sections.planLines)")
        let system = memorySystem(AgentStubProtocol.requests[1].body)
        try require(system.contains("【任务计划】") && system.contains("2. [进行中] 写《启程》的摘要") && system.contains("- c1：摘要不超过五十字"),
            "The next request lacks the plan")

        // The 24-round limit with unfinished steps offers 继续 and waits.
        AgentStubProtocol.reset((0..<25).map { AgentSSE.deepseekTools([("call_round_\($0)", "read_task_plan", "{}")]) })
        try harness.send("接着做。")
        let limit = harness.conversation.messages.last
        try require(AgentStubProtocol.requests.count == AgentChatController.maxToolRounds && AgentStubProtocol.remaining == 1
            && limit?.role == .notice && limit?.continuable == true && limit?.text.contains("24 轮") == true
            && limit?.text.contains("还有 3 步未完成") == true && limit?.text.contains("继续") == true,
            "The round limit did not offer 继续: \(limit?.text ?? "")")
        try require(harness.controller.canContinue && !panel.continueButton.isHidden, "继续 was not shown")
        pump(0.4)
        try require(!harness.controller.isRunning && AgentStubProtocol.requests.count == AgentChatController.maxToolRounds,
            "The assistant continued without the author")

        // 继续 starts a new turn that carries the plan.
        AgentStubProtocol.reset([
            AgentSSE.deepseekTools([("call_step_2b", "update_task_step", memoryArguments(["step": 2, "status": "done"])),
                                    ("call_step_3", "update_task_step", memoryArguments(["step": 3, "status": "done"])),
                                    ("call_step_4", "update_task_step", memoryArguments(["step": 4, "status": "skipped", "note": "作者另有安排"]))]),
            AgentSSE.deepseekText(["都处理完了。"]),
        ])
        panel.continueButton.performClick(nil)
        try require(harness.controller.isRunning && panel.continueButton.isHidden, "继续 did not start a turn")
        try wait { !harness.controller.isRunning }
        let continued = AgentStubProtocol.requests[0].body
        let user = AgentHarness.lastUserText(continued)
        try require(user.contains("作者点击了“继续”") && user.hasSuffix("继续") && memorySystem(continued).contains("1. [完成] 读《启程》（备注：已读）")
            && memorySystem(continued).contains("3. [待办] 读《航行》"), "The 继续 turn did not carry the plan: \(user)")
        try require(panel.transcriptTexts.contains("继续") && harness.lastReply?.text == "都处理完了。" && harness.notices.count == 1,
            "The 继续 turn differs: \(harness.notices)")
        try require(harness.conversation.plan?.unfinished == 0 && sections.plan.title == "任务计划（4/4 完成）"
            && sections.planLines.contains("– 4. 写《航行》的摘要（作者另有安排）") && !harness.controller.canContinue && panel.continueButton.isHidden,
            "The finished plan differs: \(sections.planLines)")
        // A step list with one new title keeps the others' states.
        try memoryTurn(harness, [("call_plan_more", "update_task_plan", memoryArguments(["goal": "给前两章各写一段摘要", "steps": steps + ["通读两段摘要"]]))], "再加一步。")
        try require(harness.conversation.plan?.steps.map(\.status) == [.done, .done, .done, .skipped, .todo], "Replacing the steps lost their states")
        // The plan persists with the conversation.
        let saved = harness.conversation.plan
        harness.controller.store.flush()
        harness.reopenPanel()
        try require(harness.conversation.plan.map { var plan = $0; plan.updatedAt = saved!.updatedAt; return plan } == saved
            && harness.panel.memorySections.plan.title == "任务计划（4/5 完成）", "The plan did not survive a relaunch")
        try harness.close()
    }

    // MARK: (d) Compaction

    /// Three turns: a long first request with a revision, a plan and a note,
    /// then two short ones. Returns the pending proposal's identity.
    private static func memoryHistory(_ harness: AgentHarness, prefix: String, change: (String, String)) throws -> String {
        let call = "\(prefix)_revise"
        AgentStubProtocol.reset([
            AgentSSE.deepseekTools([
                (call, "revise_chapter", memoryArguments(["title": "启程", "changes": [["currentText": change.0, "revisedText": change.1]]])),
                ("\(prefix)_plan", "update_task_plan", memoryArguments(["goal": "润色《启程》", "steps": ["改开头", "改结尾"]])),
                ("\(prefix)_note", "checkpoint_working_memory", memoryArguments(["text": "开头改成寒夜，等作者决定。"])),
            ]),
            AgentSSE.deepseekText(["我提出了一处修改。"]),
        ])
        try harness.send("第一轮：" + String(repeating: "旧", count: 3_000))
        AgentStubProtocol.reset([AgentSSE.deepseekText(["第二轮的回答。"])])
        try harness.send("第二轮：钟声要更远。")
        AgentStubProtocol.reset([AgentSSE.deepseekText(["第三轮的回答。"])])
        try harness.send("第三轮：看看结尾。")
        try require(harness.proposal(call)?.state == .pending, "The history lacks its pending proposal")
        // The next request is over the window; without the first turn it is not.
        let conversation = harness.conversation
        let probe = conversation.messages + [AgentMessage(role: .user, turnID: "probe", text: "第四轮。")]
        let request = AgentModelRequest(choice: conversation.choice.normalized(), apiKey: "synthetic", system: harness.controller.systemPrompt(for: conversation),
                                        messages: probe, turnID: "probe", tools: AgentToolRegistry.all, sessionID: conversation.id)
        let full = AgentContextBudget.estimate(request)
        harness.controller.contextWindow = { _ in Int(Double(full - 1_500) / AgentContextBudget.threshold) }
        return call
    }

    private static func memoryCompaction() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let view = try harness.open(0)
        try harness.type(view, "雨夜里钟声响起。")
        harness.controller.addRule(kind: .veto, text: "不要改动章节标题。")
        let call = try memoryHistory(harness, prefix: "sum", change: ("雨夜", "寒夜"))
        // The last message before the third turn: the second turn's answer.
        let history = harness.conversation.messages
        let throughID = history[history.lastIndex { $0.role == .user }! - 1].id
        let summary = "## 目标\n- 让钟声更悠长\n## 已做的决定\n- 开头改成寒夜\n## 待处理的提案\n- sum_revise\n## 已了解的事实\n- 第一章写雨夜钟声"
        AgentStubProtocol.reset([
            AgentSSE.deepseekComplete(summary, usage: ["prompt_tokens": 3_600, "completion_tokens": 90, "prompt_cache_hit_tokens": 0]),
            AgentSSE.deepseekText(["第四轮的回答。"]),
        ])
        try harness.send("第四轮。")
        let requests = AgentStubProtocol.requests
        try require(requests.count == 2 && harness.notices.count == 1, "Compaction sent \(requests.count) requests: \(harness.notices)")
        let summarise = requests[0].body
        let summaryMessages = summarise["messages"] as? [[String: Any]] ?? []
        let transcript = summaryMessages.last?["content"] as? String ?? ""
        try require(summarise["stream"] as? Bool == false && summarise["tools"] == nil && summarise["model"] as? String == "deepseek-v4-flash"
            && (summarise["thinking"] as? [String: Any])?["type"] as? String == "disabled"
            && summaryMessages.first?["content"] as? String == AgentCompactor.summarySystem
            && requests[0].headers["authorization"] == "Bearer synthetic-deepseek-key-0001", "The summary request differs: \(summarise.keys.sorted())")
        try require(transcript.contains("第一轮：旧旧旧") && transcript.contains("第二轮：钟声要更远。") && transcript.contains("revise_chapter")
            && !transcript.contains("第三轮"), "The summarised turns differ")
        let next = memoryMessages(requests[1].body)
        let head = next.first?["content"] as? String ?? ""
        let body = AgentJSONText.encode(requests[1].body)
        try require(next.first?["role"] as? String == "user" && head.hasPrefix(AgentCompactor.summaryHeading) && head.contains("- 让钟声更悠长")
            && head.contains("## 修改提案（应用记录）") && head.contains("提案 \(call)（revise_chapter · 修改《启程》）：等待作者决定"),
            "The compacted request lacks the summary: \(head)")
        try require(!body.contains("旧旧旧") && !body.contains("第二轮：钟声要更远。") && body.contains("第三轮：看看结尾。") && body.contains("第三轮的回答。")
            && body.contains("第四轮。"), "Older turns were sent or recent turns lost")
        let system = memorySystem(requests[1].body)
        try require(system.contains("【否决】不要改动章节标题。") && system.contains("【工作记忆】") && system.contains("【任务计划】"),
            "The compacted request lost the rules, note or plan")
        guard let marker = harness.conversation.messages.last(where: { $0.compaction != nil }), let compaction = marker.compaction else {
            throw LabError.message("No compaction marker")
        }
        try require(compaction.method == .summary && compaction.through == throughID && marker.text.hasPrefix("已压缩较早的对话")
            && (harness.panel.element("agent-compaction-\(marker.id)") as? NSTextField)?.stringValue == marker.text,
            "The marker differs: \(marker.text)")
        try require(harness.conversation.usage.contains { $0.purpose == .summary && $0.inputTokens == 3_600 && $0.outputTokens == 90 },
            "The summary request's usage was not recorded")
        // The compacted proposal is still accepted and its outcome told.
        try memoryAccept(harness, call)
        try elementSettled(harness.host, view)
        try require(harness.proposal(call)?.state == .accepted && view.textView.string == "寒夜里钟声响起。", "The compacted proposal did not apply")
        AgentStubProtocol.reset([AgentSSE.deepseekText(["好。"])])
        try harness.send("第五轮。")
        let told = AgentHarness.lastUserText(AgentStubProtocol.requests[0].body)
        try require(AgentStubProtocol.requests.count == 1 && told.contains("提案 \(call)") && told.contains("作者已接受"),
            "The outcome was not told after compaction: \(told)")
        try require(memoryMessages(AgentStubProtocol.requests[0].body).first.flatMap { $0["content"] as? String }?.hasPrefix(AgentCompactor.summaryHeading) == true,
            "The next turn lost the summary")

        // A failed summary falls back to the deterministic trim.
        harness.controller.newConversation()
        harness.controller.contextWindow = nil
        let failed = try memoryHistory(harness, prefix: "trim", change: ("钟声", "钟鸣"))
        AgentStubProtocol.reset([AgentSSE.error(500, "overloaded"), AgentSSE.deepseekText(["裁剪后的回答。"])])
        try harness.send("第四轮。")
        try memoryExpectTrim(harness, proposal: failed)
        try require(!harness.conversation.usage.contains { $0.purpose == .summary }, "A refused summary was recorded as usage")

        // So does a summary that times out.
        harness.controller.newConversation()
        harness.controller.contextWindow = nil
        let slow = try memoryHistory(harness, prefix: "slow", change: ("钟声", "钟鸣"))
        harness.controller.summaryTimeout = 0.3
        var held = AgentSSE.deepseekComplete(summary, usage: [:])
        held.hold = true
        AgentStubProtocol.reset([held, AgentSSE.deepseekText(["超时后的回答。"])])
        let started = Date()
        try harness.send("第四轮。")
        try require(Date().timeIntervalSince(started) < 10, "The summary timeout did not end the wait")
        try memoryExpectTrim(harness, proposal: slow)
        try harness.close()
    }

    private static func memoryExpectTrim(_ harness: AgentHarness, proposal: String) throws {
        let requests = AgentStubProtocol.requests
        try require(requests.count == 2 && harness.notices.count == 1, "The fallback sent \(requests.count) requests: \(harness.notices)")
        let head = memoryMessages(requests[1].body).first?["content"] as? String ?? ""
        let body = AgentJSONText.encode(requests[1].body), system = memorySystem(requests[1].body)
        try require(head.hasPrefix(AgentCompactor.summaryHeading) && head.contains("没有生成摘要") && head.contains("## 作者较早的请求")
            && head.contains("- 第二轮：钟声要更远。") && head.contains("提案 \(proposal)（revise_chapter · 修改《启程》）：等待作者决定"),
            "The trim summary differs: \(head)")
        try require(!body.contains(String(repeating: "旧", count: 300))
            && body.contains("第三轮：看看结尾。") && body.contains("第四轮。"), "The trim kept the long turn or lost recent ones")
        try require(system.contains("【否决】不要改动章节标题。") && system.contains("【工作记忆】") && system.contains("开头改成寒夜")
            && system.contains("【任务计划】") && system.contains("1. [待办] 改开头"), "The trim lost the rules, note or plan")
        guard let marker = harness.conversation.messages.last(where: { $0.compaction != nil }) else { throw LabError.message("No trim marker") }
        try require(marker.compaction?.method == .trim && marker.text.contains("摘要没有生成") && harness.proposal(proposal)?.state == .pending
            && harness.card(proposal)?.acceptButton.isEnabled == true, "The trim marker or proposal differs: \(marker.text)")
    }

    // MARK: (e) Retries

    private static func memoryRetries() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let panel = harness.panel!
        // 429 waits for its Retry-After.
        AgentStubProtocol.reset([AgentStubProtocol.Reply(status: 429, body: Data(#"{"error":{"message":"slow down"}}"#.utf8), headers: ["Retry-After": "1"]),
                                 AgentSSE.deepseekText(["等了一秒。"])])
        let started = Date()
        try memoryStart(harness, "试一下。")
        try wait { harness.controller.activity?.contains("重试中（1/3）") == true }
        try require(panel.statusLabel.stringValue.hasPrefix("重试中（1/3）：DeepSeek 请求过于频繁") && panel.statusLabel.stringValue.contains("1 秒后重新请求")
            && harness.controller.retryDelay == 1 && !panel.stopButton.isHidden && AgentStubProtocol.requests.count == 1,
            "The retry status differs: \(panel.statusLabel.stringValue)")
        try wait { !harness.controller.isRunning }
        try require(Date().timeIntervalSince(started) >= 0.9 && AgentStubProtocol.requests.count == 2 && harness.lastReply?.text == "等了一秒。"
            && harness.notices.isEmpty, "429 was not retried after its Retry-After: \(harness.notices)")
        try require(harness.conversation.usage.count == 1, "A refused attempt was recorded as usage")

        // 503 retries with backoff.
        AgentStubProtocol.reset([AgentSSE.error(503, "unavailable"), AgentSSE.error(503, "unavailable"), AgentSSE.deepseekText(["第三次成功。"])])
        try harness.send("再试。")
        try require(AgentStubProtocol.requests.count == 3 && harness.lastReply?.text == "第三次成功。" && harness.notices.isEmpty, "503 was not retried")

        // A connection dropped mid-stream is retried; its tool call runs once.
        var dropped = AgentSSE.deepseekTools([("call_drop", "revise_chapter",
            memoryArguments(["title": "启程", "changes": [["currentText": "钟声", "revisedText": "钟鸣"]]]))])
        dropped.dropAfterBody = .networkConnectionLost
        let view = try harness.open(0)
        try harness.type(view, "雨夜里钟声响起。")
        AgentStubProtocol.reset([dropped, AgentSSE.deepseekTools([("call_drop", "revise_chapter",
            memoryArguments(["title": "启程", "changes": [["currentText": "钟声", "revisedText": "钟鸣"]]]))]), AgentSSE.deepseekText(["提出了。"])])
        let usageBefore = harness.conversation.usage.count
        try harness.send("改一下钟声。")
        let messages = harness.conversation.messages
        try require(AgentStubProtocol.requests.count == 3 && harness.notices.isEmpty
            && harness.conversation.proposals.filter { $0.id == "call_drop" }.count == 1
            && messages.filter { $0.role == .tool && $0.callID == "call_drop" }.count == 1
            && messages.filter { ($0.toolCalls ?? []).contains { $0.id == "call_drop" } }.count == 1,
            "The dropped stream duplicated its tool call: \(harness.conversation.proposals.map(\.id))")
        let usage = harness.conversation.usage.dropFirst(usageBefore)
        try require(usage.count == 3 && !usage.first!.known && usage.dropFirst().allSatisfy(\.known), "The dropped attempt's usage differs")

        // 401 is never retried.
        AgentStubProtocol.reset([AgentSSE.error(401, "bad key"), AgentSSE.deepseekText(["不该出现。"])])
        try harness.send("再来。")
        try require(AgentStubProtocol.requests.count == 1 && AgentStubProtocol.remaining == 1
            && harness.notices.last?.hasPrefix("DeepSeek 拒绝了这个 API Key（HTTP 401）") == true, "401 was retried: \(harness.notices)")

        // 停止 during the backoff ends the turn at once.
        AgentStubProtocol.reset([AgentStubProtocol.Reply(status: 503, body: Data(#"{"error":{"message":"busy"}}"#.utf8), headers: ["Retry-After": "30"]),
                                 AgentSSE.deepseekText(["不该出现。"])])
        try memoryStart(harness, "最后一次。")
        try wait { harness.controller.activity?.contains("重试中（1/3）") == true }
        try require(harness.controller.retryDelay == 30 && panel.stopButton.isEnabled, "The long backoff was not scheduled")
        panel.stopButton.performClick(nil)
        try require(!harness.controller.isRunning && harness.notices.last == "已停止。" && panel.stopButton.isHidden, "停止 did not end the backoff")
        pump(0.3)
        try require(AgentStubProtocol.requests.count == 1 && AgentStubProtocol.remaining == 1, "A stopped retry was sent")
        try harness.close()
    }

    // MARK: (f) Usage

    private static func memoryUsage() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let controller = harness.controller!
        // One conversation on DeepSeek: reported usage, then none.
        AgentStubProtocol.reset([
            AgentSSE.deepseekReply("有用量。", usage: ["prompt_tokens": 1_200, "completion_tokens": 80, "prompt_cache_hit_tokens": 1_000,
                                                      "prompt_cache_miss_tokens": 200]),
            AgentSSE.deepseekReply("没有用量。", usage: nil),
        ])
        try harness.send("第一问。")
        try harness.send("第二问。")
        let first = harness.conversation.id
        // Another on Anthropic, then OpenAI.
        controller.newConversation()
        controller.setChoice(AgentModelChoice.standard.with(provider: .anthropic))
        AgentStubProtocol.reset([AgentSSE.anthropicReply("缓存很多。", start: ["input_tokens": 90, "cache_read_input_tokens": 400,
                                                                           "cache_creation_input_tokens": 100, "output_tokens": 1], output: 21)])
        try harness.send("第三问。")
        let second = harness.conversation.id
        controller.setChoice(AgentModelChoice.standard.with(provider: .openai))
        AgentStubProtocol.reset([AgentSSE.openAIReply("响应。", usage: ["input_tokens": 150, "input_tokens_details": ["cached_tokens": 64], "output_tokens": 12])])
        try harness.send("第四问。")
        controller.store.flush()
        func stored(_ id: String) throws -> [AgentUsageRecord] {
            let data = try Data(contentsOf: controller.store.directory.appendingPathComponent("\(id).json"))
            return try AgentConversationStore.decoder().decode(AgentConversation.self, from: data).usage
        }
        let a = try stored(first), b = try stored(second)
        try require(a.count == 2 && a[0].provider == .deepseek && a[0].model == "deepseek-v4-flash" && a[0].inputTokens == 1_200
            && a[0].cachedTokens == 1_000 && a[0].outputTokens == 80 && a[0].known
            && a[1].inputTokens == nil && a[1].outputTokens == nil && a[1].cachedTokens == nil && !a[1].known,
            "DeepSeek usage differs: \(a)")
        try require(b.count == 2 && b[0].provider == .anthropic && b[0].model == "claude-sonnet-5" && b[0].inputTokens == 590 && b[0].cachedTokens == 400
            && b[0].outputTokens == 21 && b[1].provider == .openai && b[1].model == "gpt-5.6-sol" && b[1].inputTokens == 150 && b[1].cachedTokens == 64
            && b[1].outputTokens == 12, "Anthropic or OpenAI usage differs: \(b)")
        let raw = try String(contentsOf: controller.store.directory.appendingPathComponent("\(first).json"), encoding: .utf8)
        try require(!raw.contains("price") && !raw.contains("cost") && !raw.contains("synthetic-"), "The usage record holds a price or a key")

        // Totals today and over 30 days, by provider and model.
        let report = AgentUsageReport(conversations: controller.conversations)
        try require(report.today.requests == 4 && report.today.unknown == 1 && report.today.inputTokens == 1_940 && report.today.cachedTokens == 1_464
            && report.today.outputTokens == 113 && report.month == report.today, "Project totals differ: \(report.today)")
        try require(report.models.map(\.label) == ["DeepSeek · DeepSeek Flash", "Anthropic · Sonnet 5", "OpenAI · 5.6 Sol"]
            && report.models[0].today.requests == 2 && report.models[0].today.unknown == 1 && report.conversations.count == 2,
            "Model rows differ: \(report.models.map(\.label))")
        try require(report.today.text == "输入 1,940（缓存 1,464）· 输出 113 · 4 次请求（1 次用量未知）", "The total text differs: \(report.today.text)")
        let now = Date()
        var synthetic = AgentConversation(projectID: harness.project.id)
        synthetic.title = "合成用量"
        synthetic.usage = [
            AgentUsageRecord(provider: .deepseek, model: "deepseek-v4-pro", purpose: .reply, usage: AgentUsage(inputTokens: 10, cachedTokens: 0, outputTokens: 5), at: now),
            AgentUsageRecord(provider: .deepseek, model: "deepseek-v4-pro", purpose: .summary, usage: AgentUsage(inputTokens: 100, cachedTokens: 50, outputTokens: 20),
                             at: Calendar.current.date(byAdding: .day, value: -3, to: now)!),
            AgentUsageRecord(provider: .deepseek, model: "deepseek-v4-pro", purpose: .reply, usage: AgentUsage(inputTokens: 1_000, cachedTokens: nil, outputTokens: 7),
                             at: Calendar.current.date(byAdding: .day, value: -40, to: now)!),
        ]
        let windowed = AgentUsageReport(conversations: [synthetic], now: now)
        try require(windowed.today.inputTokens == 10 && windowed.month.inputTokens == 110 && windowed.month.requests == 2
            && windowed.conversations.first?.totals.inputTokens == 1_110 && windowed.models.map(\.label) == ["DeepSeek · DeepSeek Pro"]
            && windowed.models[0].today.requests == 1 && windowed.models[0].month.requests == 2, "Day and 30-day windows differ")

        // 设置 › 写作助手 › 用量.
        let pane = MacAgentSettingsViewController()
        pane.source = { (harness.project.name, controller.conversations) }
        _ = pane.view
        try require(pane.projectLabel.stringValue == "项目《写作助手合成项目》" && pane.todayLabel.stringValue == report.today.text
            && pane.monthLabel.stringValue == report.month.text && pane.modelsStack.arrangedSubviews.count == 3
            && pane.modelsStack.arrangedSubviews[0].accessibilityLabel() == "DeepSeek · DeepSeek Flash，今天：\(report.models[0].today.text)，近 30 天：\(report.models[0].month.text)"
            && pane.conversationsStack.arrangedSubviews.map { $0.accessibilityIdentifier() }
                == ["settings-agent-usage-conversation-\(second)", "settings-agent-usage-conversation-\(first)"],
            "The usage pane differs: \(pane.todayLabel.stringValue)")
        let settings = MacSettingsWindowController(store: LabSettingsStore(directory: harness.directory.appendingPathComponent("settings-probe")))
        try require(settings.agentPane.title == "写作助手", "设置 lacks the 写作助手 tab")

        // Deleting a conversation asks, then removes its usage.
        controller.select(first)
        harness.answer = { _ in .alertSecondButtonReturn }
        harness.panel.deleteButton.performClick(nil)
        try require(controller.conversations.count == 2 && pane.todayLabel.stringValue == report.today.text, "取消 removed usage")
        var asked = ""
        harness.answer = { alert in asked = alert.informativeText; return .alertFirstButtonReturn }
        harness.panel.deleteButton.performClick(nil)
        controller.store.flush()
        try require(asked.contains("用量记录") && controller.conversations.map(\.id) == [second]
            && !FileManager.default.fileExists(atPath: controller.store.directory.appendingPathComponent("\(first).json").path),
            "Delete did not remove the conversation: \(asked)")
        try require(pane.todayLabel.stringValue == "输入 740（缓存 464）· 输出 33 · 2 次请求" && pane.conversationsStack.arrangedSubviews.count == 1,
            "The pane did not follow the deletion: \(pane.todayLabel.stringValue)")
        try harness.close()
    }

    // MARK: (g) Authorship and one-original creation

    private static func memoryAuthorship() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let w = harness.workspace, p = harness.project.id
        let journal = JournalProbe(directory: harness.directory)
        let people: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult { w.createElementCategory(projectID: p, name: "人物", completion: $0) }
        try memoryTurn(harness, [
            ("call_todo", "create_comment", memoryArguments(["kind": "todo", "target": ["kind": "chapter", "name": "启程"], "body": "补写钟楼的来历。"])),
            ("call_shen", "create_element", memoryArguments(["category": "人物", "name": "沈舟", "summary": "渡口的船夫。", "aliases": ["老沈"],
                                                             "facts": [["key": "年龄", "value": "四十"]]])),
            ("call_lin", "create_element", memoryArguments(["category": "人物", "name": "林岚", "group": "北岸众", "summary": "守灯人。", "aliases": ["阿岚"],
                                                            "facts": [["key": "年龄", "value": "二十"], ["key": "住处", "value": "北塔"]]])),
        ], "记个待办，再建两个人物。")

        // The accepted TODO is the assistant's.
        try memoryAccept(harness, "call_todo")
        let comments: [WorkspaceComment] = try elementResult { w.projectComments(projectID: p, completion: $0) }
        guard let todo = comments.first(where: { $0.bodyText == "补写钟楼的来历。" }) else { throw LabError.message("The TODO was not created") }
        try require(todo.authorKind == "ai" && todo.authorName == "写作助手" && todo.authorId == nil && todo.source == "api"
            && todo.isByAssistant && todo.canEditBody, "The TODO's author differs: \(todo.authorKind) \(todo.source)")
        let _: WorkspaceCommentsReply = try elementResult { w.createComment(projectID: p, kind: "todo", target: nil, body: "作者自己的待办。", priority: nil, completion: $0) }
        let model = ReviewModel(workspace: w, projectID: p, associations: harness.host.relations.associations(projectID: p))
        let review = MacReviewViewController(model: model)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 720), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = review
        review.view.layoutSubtreeIfNeeded()
        model.setFocus(nil)
        model.load()
        try wait { model.loaded && review.card(commentID: todo.id) != nil }
        let everything: [WorkspaceComment] = try elementResult { w.projectComments(projectID: p, completion: $0) }
        let authored = everything.first { $0.bodyText == "作者自己的待办。" }!
        try wait { review.card(commentID: authored.id) != nil }
        let card = review.card(commentID: todo.id)!, own = review.card(commentID: authored.id)!
        try require(card.headerLabel.stringValue.contains("写作助手") && !card.editButton.isHidden
            && !own.headerLabel.stringValue.contains("写作助手") && !own.headerLabel.stringValue.contains("外部来源"),
            "审阅 cards differ: \(card.headerLabel.stringValue) / \(own.headerLabel.stringValue)")
        window.close()

        // A refused alias leaves nothing of the element.
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            w.createElement(projectID: p, categoryID: people.result!.id, name: "老沈", completion: $0)
        }
        var mark = try journal.mark()
        try memoryAccept(harness, "call_shen")
        let refused = harness.proposal("call_shen")
        var library: WorkspaceElementLibrary = try elementResult { w.elementLibrary(projectID: p, completion: $0) }
        try require(refused?.state == .failed && (refused?.message ?? "").unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) }
            && !library.elements.contains { $0.name == "沈舟" } && (try journal.originals(since: mark)).isEmpty,
            "A refused alias left part of the element: \(refused?.message ?? "")")
        // An accepted one writes every field in one original.
        mark = try journal.mark()
        try memoryAccept(harness, "call_lin")
        library = try elementResult { w.elementLibrary(projectID: p, completion: $0) }
        let originals = try journal.originals(since: mark)
        guard let lin = library.elements.first(where: { $0.name == "林岚" }) else { throw LabError.message("林岚 was not created") }
        try require(harness.proposal("call_lin")?.state == .accepted && harness.proposal("call_lin")?.partial == nil
            && lin.groupName == "北岸众" && lin.summary == "守灯人。" && lin.aliases == ["阿岚"]
            && lin.facts == [WorkspaceFact(key: "年龄", value: "二十"), WorkspaceFact(key: "住处", value: "北塔")]
            && originals.count == 1 && originals[0].contains("entity.create element") && originals[0].contains("set.add alias")
            && originals[0].filter { $0 == "entity.create kv-entry" }.count == 2, "create_element was not one original: \(originals)")
        try harness.close()
    }
}

extension AgentSSE {
    /// A DeepSeek text reply with the given usage chunk, or none.
    static func deepseekReply(_ text: String, usage: [String: Any]?) -> AgentStubProtocol.Reply {
        var events: [[String: Any]] = [["choices": [["index": 0, "delta": ["role": "assistant", "content": text]]]],
                                       ["choices": [["index": 0, "delta": [:], "finish_reason": "stop"]]]]
        if let usage { events.append(["choices": [], "usage": usage]) }
        return reply(events, done: true)
    }

    /// A complete (non-streamed) DeepSeek reply, as compaction requests one.
    static func deepseekComplete(_ text: String, usage: [String: Any]) -> AgentStubProtocol.Reply {
        AgentStubProtocol.Reply(body: Data(AgentJSONText.encode([
            "id": "chatcmpl-synthetic", "object": "chat.completion",
            "choices": [["index": 0, "message": ["role": "assistant", "content": text], "finish_reason": "stop"]],
            "usage": usage,
        ]).utf8))
    }

    static func anthropicReply(_ text: String, start: [String: Any], output: Int) -> AgentStubProtocol.Reply {
        reply([
            ["type": "message_start", "message": ["id": "msg_usage", "type": "message", "role": "assistant", "content": [],
                                                  "model": "claude-sonnet-5", "usage": start]],
            ["type": "content_block_start", "index": 0, "content_block": ["type": "text", "text": ""]],
            ["type": "content_block_delta", "index": 0, "delta": ["type": "text_delta", "text": text]],
            ["type": "content_block_stop", "index": 0],
            ["type": "message_delta", "delta": ["stop_reason": "end_turn"], "usage": ["output_tokens": output]],
            ["type": "message_stop"],
        ])
    }

    static func openAIReply(_ text: String, usage: [String: Any]) -> AgentStubProtocol.Reply {
        let message: [String: Any] = ["type": "message", "id": "msg_usage", "role": "assistant", "status": "completed",
                                      "content": [["type": "output_text", "text": text, "annotations": []]]]
        return reply([
            ["type": "response.output_text.delta", "item_id": "msg_usage", "output_index": 0, "content_index": 0, "delta": text],
            ["type": "response.output_item.done", "output_index": 0, "item": message],
            ["type": "response.completed", "response": ["id": "resp_usage", "status": "completed", "output": [message], "usage": usage]],
        ])
    }
}
