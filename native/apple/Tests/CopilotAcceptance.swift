import AppKit

/// Copilot（实验） through the real tab host, editor views, 审阅 panel, the
/// chapter's 批注 panel, the settings pane and store, the Rust workspace and
/// SQLite, wired as AppDelegate wires them. Providers are stubbed with
/// synthetic JSON replies and keys are synthetic and in memory; nothing
/// reaches a real provider. Every name and line of prose is synthetic.
extension BindingAcceptance {
    static func copilotAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay)
        defer { (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay) = saved }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        try copilotOffAndSettings()
        try copilotTriggers()
        try copilotExtraction()
        try copilotPatchesAndReview()
        try copilotCancellation()
        try copilotDrifts()
        return [
            "AppKit Copilot is off by default: edits and 分析 send no request, the menu offers nothing and no status shows; 设置 › Copilot（实验） shows every option with the privacy note, writes provider, model, tasks, trigger, delay, language and the drift switch to settings.json, reads them back after a relaunch and falls back value by value for damaged ones",
            "AppKit Copilot runs once typing has stopped for the idle delay (typing again restarts it) and by hand through 编辑 › Copilot 分析 and the prose context menu, sends only the paragraphs changed since its last run (else the selected ones) with the library's names and categories, anchors a suggestion through the chapter's owner as its only journal original, and leaves prose and undo untouched",
            "AppKit Copilot element suggestions leave out existing names, aliases and names the author rejected (sent in the prompt too), map unknown categories to 未分类, drop proposals whose evidence is not in the chapter, anchor each to its evidence, list under 审阅's Copilot filter and in the chapter's 批注 panel with 接受 and 拒绝, record usage beside the assistant's and show it in 设置 › 写作助手 › 用量",
            "AppKit Copilot patch suggestions cover elements named in the changed paragraphs, skip existing valid patches and rejected ones; 接受 creates the element (choosing a category for 未分类) or the patch anchored to the evidence and records accept_suggestion with its elementId or patchId, 拒绝 records reject_suggestion, both in one original each, decided suggestions leave the open lists, and a refused create leaves the suggestion open with the reason and writes nothing",
            "AppKit Copilot never holds typing while a request is out, runs one request at a time per project, stops its request when the chapter's tab closes without adding anything, retries 503 with the assistant's policy, does not retry 401, and reports a missing key in its quiet status",
            "AppKit Copilot works in drifts only with 在灵感中启用: off, drift edits send nothing; on, the drift's changed paragraphs are sent and the suggestion is anchored in the drift body; turning it off stops a drift run",
        ]
    }

    // MARK: Harness

    final class CopilotHarness {
        let directory: URL
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let chapters: [WorkspaceChapter]
        let window: NSWindow
        let host: MacChapterWorkspace
        let journal: JournalProbe
        let credentials = AgentMemoryCredentialStore([.deepseek: "synthetic-deepseek-key-0001", .anthropic: "synthetic-anthropic-key-0002"])
        let network = AgentNetwork(configuration: AgentStubProtocol.configuration)
        let settings: LabSettingsStore
        private(set) var controller: CopilotController!
        let review: ReviewModel
        let reviewController: MacReviewViewController
        let reviewWindow: NSWindow
        var statuses: [CopilotStatus] = []
        var changes: [CopilotReviewChange] = []
        var effects: [AgentWorkspaceEffect] = []
        /// The chapter's 批注 panel, when a case shows it.
        var commentsPanel: ChapterCommentsModel?
        private(set) var categories: [String: WorkspaceElementCategory] = [:]
        private(set) var elements: [String: WorkspaceElement] = [:]
        private var observer: NSObjectProtocol?

        init(titles: [String], categories names: [String] = [], elements seeds: [(name: String, category: String, aliases: [String])] = []) throws {
            directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Copilot fixture was not isolated")
            let project: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: "Copilot 合成项目", completion: $0) }
            self.project = project
            for name in names {
                let reply: WorkspaceElementReply<WorkspaceElementCategory> = try BindingAcceptance.elementResult {
                    workspace.createElementCategory(projectID: project.id, name: name, completion: $0)
                }
                categories[name] = reply.result!
            }
            for seed in seeds {
                let categoryID = categories[seed.category]!.id
                let reply: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                    workspace.createElement(projectID: project.id, categoryID: categoryID, name: seed.name,
                                            aliases: seed.aliases.isEmpty ? nil : seed.aliases, completion: $0)
                }
                elements[seed.name] = reply.result!
            }
            chapters = try titles.map { title in
                try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            settings = LabSettingsStore(directory: directory.deletingLastPathComponent())
            review = ReviewModel(workspace: workspace, projectID: project.id, associations: host.relations.associations(projectID: project.id))
            reviewController = MacReviewViewController(model: review)
            reviewWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 900), styleMask: [.titled, .resizable],
                                    backing: .buffered, defer: false)
            reviewWindow.isReleasedWhenClosed = false
            reviewWindow.contentViewController = reviewController
            reviewController.view.layoutSubtreeIfNeeded()
            makeController()
            observer = NotificationCenter.default.addObserver(forName: LabSettingsStore.copilotDidChange, object: settings, queue: nil) { [weak self] _ in
                self?.controller.settingsChanged()
            }
            review.setFocus(nil)
            review.load()
            try BindingAcceptance.wait { self.review.loaded }
        }

        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

        /// A controller wired as AppDelegate.copilot(for:) wires one.
        func makeController() {
            let controller = CopilotController(workspace: workspace, projectID: project.id, credentials: credentials, network: network)
            let settings = self.settings, host = self.host, review = self.review, projectID = project.id
            controller.settings = { settings.settings.copilot }
            controller.manuscriptLocale = { settings.settings.manuscriptLocale }
            // Retries wait a hundredth of a second; the idle delay is short.
            controller.retryPolicy.baseDelay = 0.01
            controller.idleDelay = { _ in 0.4 }
            controller.openStore = { kind, id in host.copilotStore(projectID: projectID, kind: kind, id: id) }
            controller.onStatus = { [weak self] status in self?.statuses.append(status); host.copilotStatus = status.text }
            controller.onWorkspaceEffect = { [weak self] effect in self?.effects.append(effect); host.adoptAgentEffect(effect) }
            controller.onReviewChange = { [weak self] change in
                self?.changes.append(change)
                switch change {
                case .created: review.load()
                case .decided(let id, let comments, let message):
                    review.adopt(comments, message: message)
                    if let panel = self?.commentsPanel, panel.comments.contains(where: { $0.id == id }) { panel.reload(after: message) }
                case .failed(let id, let message):
                    review.showStatus(message)
                    if let panel = self?.commentsPanel, panel.comments.contains(where: { $0.id == id }) { panel.showStatus(message) }
                case .deciding: review.showStatus("正在处理 Copilot 建议…")
                }
            }
            host.copilot = { [weak self] id in id == projectID ? self?.controller : nil }
            reviewController.commands.copilot = CopilotSuggestionCommands(controller: { [weak self] in self?.controller },
                                                                          library: { host.elementLibrary(projectID: projectID) })
            // A passage's live anchor, as AppDelegate.liveAnchor reads it.
            reviewController.anchor = { comment in
                guard comment.targetKind == "node", let chapter = comment.targetId else { return nil }
                return host.copilotStore(projectID: projectID, kind: .chapter, id: chapter)?.projection?.comments.first { $0.id == comment.id }
            }
            self.controller = controller
        }

        func enable(_ change: (inout CopilotSettings) -> Void = { _ in }) {
            settings.setCopilot { settings in settings.enabled = true; change(&settings) }
        }

        func open(_ index: Int) throws -> NativeDocumentView {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, chapter: chapters[index], completion: $0) }
            try settle(view)
            let projectID = project.id
            try BindingAcceptance.wait { self.host.linkDirectory(projectID: projectID) != nil }
            return view
        }

        /// Input saved and entity links applied: nothing more is written until the next edit.
        func settle(_ views: NativeDocumentView...) throws {
            try BindingAcceptance.wait {
                !self.host.isBusy && views.allSatisfy { $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks }
            }
        }

        /// Types at the end of the body through the text view.
        func type(_ view: NativeDocumentView, _ text: String) throws {
            view.textView.insertText(text, replacementRange: NSRange(location: (view.textView.string as NSString).length, length: 0))
            try BindingAcceptance.wait { !view.binding.hasPendingWork }
        }

        func waitRun(file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) { !self.controller.isRunning }
        }

        func comments() throws -> [WorkspaceComment] {
            let workspace = self.workspace, projectID = project.id
            return try BindingAcceptance.elementResult { workspace.projectComments(projectID: projectID, completion: $0) }
        }

        func suggestions() throws -> [WorkspaceComment] { try comments().filter(\.isCopilot) }

        func actions() throws -> [WorkspaceCommentAction] {
            let workspace = self.workspace, projectID = project.id
            return try BindingAcceptance.elementResult { workspace.suggestionActions(projectID: projectID, completion: $0) }
        }

        func library() throws -> WorkspaceElementLibrary {
            let workspace = self.workspace, projectID = project.id
            return try BindingAcceptance.elementResult { workspace.elementLibrary(projectID: projectID, completion: $0) }
        }

        func patches(_ elementID: String) throws -> [WorkspacePatch] {
            let workspace = self.workspace, projectID = project.id
            return try BindingAcceptance.elementResult { workspace.elementPatches(projectID: projectID, elementID: elementID, completion: $0) }
        }

        /// The suggestion whose metadata names `name` (an element name or a patch title).
        func suggestion(_ name: String) throws -> WorkspaceComment {
            guard let found = try suggestions().first(where: { comment in
                switch CopilotProposal(comment) {
                case .element(let candidate)?: return candidate.name == name
                case .patch(let candidate)?: return candidate.title == name
                case nil: return false
                }
            }) else { throw LabError.message("No suggestion names \(name)") }
            return found
        }

        func contextMenu(_ view: NativeDocumentView, at index: Int) throws -> NSMenu {
            guard let window = view.window, let event = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1),
                  let menu = view.textView(view.textView, menu: NSMenu(), for: event, at: index) else {
                throw LabError.message("Prose context menu was not built")
            }
            return menu
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            controller.cancelAll()
            controller.store.flush()
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Copilot workspace failed to close")
            window.close(); reviewWindow.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    // MARK: Helpers

    /// A complete DeepSeek reply whose text is the JSON object.
    private static func copilotReply(_ object: [String: Any], usage: [String: Any] = ["prompt_tokens": 320, "completion_tokens": 48,
                                                                                         "prompt_cache_hit_tokens": 0]) -> AgentStubProtocol.Reply {
        AgentSSE.deepseekComplete(AgentJSONText.encode(object), usage: usage)
    }

    private static func copilotElements(_ rows: [[String: String]]) -> AgentStubProtocol.Reply { copilotReply(["elements": rows]) }
    private static func copilotPatches(_ rows: [[String: String]]) -> AgentStubProtocol.Reply { copilotReply(["patches": rows]) }

    /// The system prompt and user message of a captured request.
    private static func copilotPrompt(_ index: Int) -> (system: String, user: String) {
        let requests = AgentStubProtocol.requests
        guard requests.indices.contains(index), let messages = requests[index].body["messages"] as? [[String: Any]] else { return ("", "") }
        return (messages.first { $0["role"] as? String == "system" }?["content"] as? String ?? "",
                messages.first { $0["role"] as? String == "user" }?["content"] as? String ?? "")
    }

    private static func copilotFind(_ identifier: String, in view: NSView) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for child in view.subviews { if let found = copilotFind(identifier, in: child) { return found } }
        return nil
    }

    private static func pumpCopilot(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
    }

    /// The live anchor quote of a suggestion in its open chapter.
    private static func copilotQuote(_ view: NativeDocumentView, _ comment: WorkspaceComment) -> String? {
        view.binding.store.projection?.comments.first { $0.id == comment.id }?.quote
    }

    private static let resolveOriginal = ["field.set comment", "field.set comment", "entity.create comment-action"]

    /// Originals without the entity-link passes a new element name starts
    /// in open bodies (marks only; the text is unchanged).
    private static func withoutLinks(_ originals: [[String]]) -> [[String]] {
        originals.filter { $0 != ["yjs.update prose-document"] }
    }

    // MARK: (a) Off by default, 设置

    private static func copilotOffAndSettings() throws {
        let harness = try CopilotHarness(titles: ["启程"], categories: ["人物"])
        defer { harness.remove() }
        let view = try harness.open(0)
        AgentStubProtocol.reset([])
        try require(!harness.settings.settings.copilot.enabled && CopilotSettings() == harness.settings.settings.copilot,
            "Copilot was not off by default")
        try harness.type(view, "林岚走上北塔，看见了守灯人。")
        pumpCopilot(0.8)
        try require(AgentStubProtocol.requests.isEmpty && harness.statuses.isEmpty && harness.host.copilotStatus == nil,
            "Copilot sent a request or showed a status while off")
        try require(!view.canRequestCopilot && !(try harness.contextMenu(view, at: 0)).items.contains { $0.accessibilityIdentifier() == "context-copilot-analyze" }
            && !harness.controller.analyze(kind: .chapter, id: harness.chapters[0].id, store: view.binding.store, selection: NSRange(location: 0, length: 2)),
            "Copilot 分析 was offered while off")
        view.textView.copilotAnalyze(nil)
        pumpCopilot(0.3)
        try require(AgentStubProtocol.requests.isEmpty && !harness.controller.isRunning, "⇧⌘I ran Copilot while off")

        // 设置 › Copilot（实验）.
        let pane = MacCopilotSettingsViewController(store: harness.settings)
        pane.credentials = harness.credentials
        _ = pane.view
        try require(pane.enabledCheckbox.state == .off && pane.providerPopup.titleOfSelectedItem == "DeepSeek"
            && pane.modelPopup.titleOfSelectedItem == "DeepSeek Flash · 快速" && pane.keyLabel.stringValue == "已保存 ····0001"
            && pane.extractCheckbox.state == .on && pane.patchCheckbox.state == .on && pane.triggerControl.selectedSegment == 0
            && pane.secondsLabel.stringValue == "停笔 20 秒后" && pane.secondsStepper.isEnabled
            && pane.languagePopup.titleOfSelectedItem == "跟随手稿" && pane.driftCheckbox.state == .off,
            "The pane's defaults differ")
        try require(pane.privacyText.stringValue.contains("发送给所选的模型服务") && pane.privacyText.stringValue.contains("费用")
            && pane.privacyText.stringValue.contains("数据留存"), "The privacy note is missing: \(pane.privacyText.stringValue)")
        let window = MacSettingsWindowController(store: harness.settings)
        try require(window.copilotPane.title == "Copilot（实验）", "设置 lacks the Copilot tab")
        pane.enabledCheckbox.performClick(nil)
        pane.providerPopup.selectItem(withTitle: "Anthropic"); pane.providerChanged()
        try require(harness.settings.settings.copilot.provider == .anthropic && harness.settings.settings.copilot.model == "claude-sonnet-5"
            && pane.modelPopup.itemTitles == ["Claude Sonnet 5 · 均衡", "Claude Haiku 4.5 · 快速"] && pane.keyLabel.stringValue == "已保存 ····0002",
            "Another provider did not start at its first model with its key")
        pane.modelPopup.selectItem(at: 1); pane.modelChanged()
        pane.patchCheckbox.performClick(nil)
        pane.triggerControl.selectedSegment = 1; pane.triggerChanged()
        try require(!pane.secondsStepper.isEnabled && harness.settings.settings.copilot.trigger == .manual, "仅手动 did not apply")
        pane.triggerControl.selectedSegment = 0; pane.triggerChanged()
        pane.secondsStepper.doubleValue = 45; pane.secondsChanged()
        pane.languagePopup.selectItem(withTitle: "English"); pane.languageChanged()
        pane.driftCheckbox.performClick(nil)
        var expected = CopilotSettings()
        expected.enabled = true; expected.provider = .anthropic; expected.model = "claude-haiku-4-5-20251001"; expected.suggestPatches = false
        expected.idleSeconds = 45; expected.language = "en"; expected.inDrifts = true
        try require(harness.settings.settings.copilot == expected && pane.secondsLabel.stringValue == "停笔 45 秒后",
            "The pane did not store every choice: \(harness.settings.settings.copilot)")
        // settings.json holds it; a relaunch reads it back.
        let stored = try JSONSerialization.jsonObject(with: Data(contentsOf: harness.settings.fileURL)) as? [String: Any]
        try require((stored?["copilot"] as? [String: Any])?["model"] as? String == "claude-haiku-4-5-20251001", "settings.json lacks Copilot")
        let relaunched = LabSettingsStore(directory: harness.settings.directory)
        let reopened = MacCopilotSettingsViewController(store: relaunched)
        reopened.credentials = harness.credentials
        _ = reopened.view
        try require(relaunched.settings.copilot == expected && reopened.enabledCheckbox.state == .on && reopened.providerPopup.titleOfSelectedItem == "Anthropic"
            && reopened.modelPopup.titleOfSelectedItem == "Claude Haiku 4.5 · 快速" && reopened.patchCheckbox.state == .off
            && reopened.secondsLabel.stringValue == "停笔 45 秒后" && reopened.languagePopup.titleOfSelectedItem == "English"
            && reopened.driftCheckbox.state == .on, "Copilot settings did not survive a relaunch")
        // Damaged values fall back one by one.
        var raw = stored ?? [:]
        raw["copilot"] = ["enabled": true, "provider": "unknown", "model": 7, "idleSeconds": 2, "language": "xx", "trigger": "manual", "inDrifts": "yes"]
        try JSONSerialization.data(withJSONObject: raw).write(to: harness.settings.fileURL)
        let damaged = LabSettingsStore(directory: harness.settings.directory).settings.copilot
        try require(damaged.enabled && damaged.provider == .deepseek && damaged.model == "deepseek-v4-flash" && damaged.idleSeconds == 5
            && damaged.language == "auto" && damaged.trigger == .manual && !damaged.inDrifts, "Damaged Copilot settings did not fall back: \(damaged)")
        window.close()
        try harness.close()
    }

    // MARK: (b) Triggers and changed paragraphs

    private static func copilotTriggers() throws {
        let harness = try CopilotHarness(titles: ["启程"], categories: ["人物", "地点"],
                                         elements: [("林岚", "人物", ["阿岚"]), ("北塔", "地点", [])])
        defer { harness.remove() }
        let view = try harness.open(0)
        let chapterID = harness.chapters[0].id
        // Written before Copilot was on: never sent.
        try harness.type(view, "林岚走上北塔。\n海风很冷。\n灯塔的光转了一圈。")
        try harness.settle(view)
        harness.enable { $0.suggestPatches = false }
        harness.controller.idleDelay = { _ in 0.8 }
        AgentStubProtocol.reset([copilotElements([["name": "沈舟", "category": "人物", "summary": "在渡口等人的船夫。", "evidence": "沈舟在渡口等她"]])])

        // Typing again before the delay restarts it.
        try harness.type(view, "\n沈舟在渡口等她。")
        pumpCopilot(0.5)
        try require(AgentStubProtocol.requests.isEmpty && !harness.controller.isRunning, "Copilot ran before the idle delay")
        try harness.type(view, "他提着一盏马灯。")
        let lastKey = Date()
        try harness.settle(view)
        let mark = try harness.journal.mark()
        let before = view.textView.string
        pumpCopilot(0.4)
        try require(AgentStubProtocol.requests.isEmpty, "Typing did not restart the idle delay")
        try wait { AgentStubProtocol.requests.count == 1 }
        try require(Date().timeIntervalSince(lastKey) >= 0.75, "Copilot did not wait for the idle delay after the last keystroke")
        try harness.waitRun()
        let request = AgentStubProtocol.requests[0]
        let (system, user) = copilotPrompt(0)
        try require(request.url.absoluteString == "https://api.deepseek.com/v1/chat/completions" && request.body["stream"] as? Bool == false
            && request.body["model"] as? String == "deepseek-v4-flash" && request.body["tools"] == nil
            && (request.body["thinking"] as? [String: Any])?["type"] as? String == "disabled"
            && request.headers["authorization"] == "Bearer synthetic-deepseek-key-0001" && system == CopilotPrompt.extractSystem,
            "The request shape differs: \(request.body.keys.sorted())")
        try require(user.contains("[1] 沈舟在渡口等她。他提着一盏马灯。") && !user.contains("[2]") && !user.contains("海风很冷")
            && !user.contains("林岚走上北塔") && !user.contains("灯塔的光") && user.contains("【已有名称】北塔、林岚、阿岚")
            && user.contains("【可用分类】人物、地点") && user.contains("【作者拒绝过的名称】（无）") && user.contains("手稿默认语言：简体中文"),
            "The request did not carry only the changed paragraph: \(user)")
        guard case .proposed(1)? = harness.statuses.last else { throw LabError.message("The status differs: \(harness.statuses)") }
        try require(harness.host.copilotStatus == "Copilot 已提出 1 条建议" && harness.statuses.contains(.analyzing), "The quiet status differs")
        let created = try harness.suggestions()
        try require(created.count == 1 && created[0].authorKind == "copilot" && created[0].authorName == "Copilot" && created[0].kind == "note"
            && created[0].targetKind == "node" && created[0].targetId == chapterID && created[0].review == .open
            && created[0].bodyText == "新设定「沈舟」（人物）\n\n在渡口等人的船夫。", "The suggestion row differs: \(created)")
        guard case .element(let candidate)? = CopilotProposal(created[0]) else { throw LabError.message("The metadata is not an element") }
        let metadata = AgentJSONText.object(created[0].metadataJson ?? "") ?? [:]
        try require(candidate == CopilotElementCandidate(name: "沈舟", category: "人物", summary: "在渡口等人的船夫。", evidence: "沈舟在渡口等她")
            && metadata["provider"] as? String == "deepseek" && metadata["model"] as? String == "deepseek-v4-flash",
            "The metadata differs: \(created[0].metadataJson ?? "")")
        try require(copilotQuote(view, created[0]) == "沈舟在渡口等她", "The suggestion is not anchored to its evidence")
        // No prose was written: one comment original, the same text, and
        // undo still takes back the author's last input.
        try harness.journal.expect([["entity.create comment"]], since: mark, "A Copilot run")
        try require(view.textView.string == before, "A Copilot run changed the prose")
        view.undoProse(); try harness.settle(view)
        try require(!view.textView.string.contains("他提着一盏马灯。") && view.textView.string.contains("沈舟在渡口等她。"),
            "Undo did not take back the author's input: \(view.textView.string)")
        view.redoProse(); try harness.settle(view)
        try require(view.textView.string == before, "Redo did not restore the author's input")

        // 仅手动: nothing runs by itself; the context menu and ⇧⌘I do.
        harness.enable { $0.suggestPatches = false; $0.trigger = .manual }
        AgentStubProtocol.reset([copilotElements([]), copilotElements([])])
        try harness.type(view, "\n风把灯吹灭了。")
        try harness.settle(view)
        pumpCopilot(1.0)
        try require(AgentStubProtocol.requests.isEmpty, "仅手动 ran by itself")
        let caret = (view.textView.string as NSString).length
        view.textView.setSelectedRange(NSRange(location: caret, length: 0))
        let menu = try harness.contextMenu(view, at: 0)
        guard let item = menu.items.first(where: { $0.accessibilityIdentifier() == "context-copilot-analyze" }), let action = item.action else {
            throw LabError.message("The context menu lacks Copilot 分析")
        }
        try require(item.title == "Copilot 分析", "The Copilot item is misnamed")
        NSApp.sendAction(action, to: item.target, from: item)
        try harness.waitRun()
        let manual = copilotPrompt(0).user
        try require(AgentStubProtocol.requests.count == 1 && manual.contains("[1] 风把灯吹灭了。") && !manual.contains("[2]"),
            "Copilot 分析 did not send the changed paragraph: \(manual)")
        try require(harness.statuses.last == .nothing && harness.host.copilotStatus == "Copilot 没有新建议", "An empty reply's status differs")
        // Nothing changed since: ⇧⌘I reads the selected paragraph.
        let wind = (view.textView.string as NSString).range(of: "海风很冷")
        view.textView.setSelectedRange(wind)
        try require(view.textView.validateMenuItem(NSMenuItem(title: "", action: #selector(ProseTextView.copilotAnalyze(_:)), keyEquivalent: "")),
            "⇧⌘I was not enabled")
        view.textView.copilotAnalyze(nil)
        try harness.waitRun()
        let selected = copilotPrompt(1).user
        try require(AgentStubProtocol.requests.count == 2 && selected.contains("[1] 海风很冷。") && !selected.contains("[2]"),
            "⇧⌘I did not send the selected paragraph: \(selected)")
        // With nothing new and no selection there is nothing to read.
        view.textView.setSelectedRange(NSRange(location: caret, length: 0))
        harness.controller.analyze(kind: .chapter, id: chapterID, store: view.binding.store, selection: nil)
        try require(AgentStubProtocol.requests.count == 2 && harness.host.copilotStatus == "Copilot：没有需要分析的新段落。",
            "An analysis with nothing new sent a request")
        try harness.close()
    }

    // MARK: (c) Element suggestions, exclusions, evidence, 审阅 and usage

    private static func copilotExtraction() throws {
        let harness = try CopilotHarness(titles: ["北岸"], categories: ["人物", "地点"], elements: [("林岚", "人物", ["阿岚"])])
        defer { harness.remove() }
        let view = try harness.open(0)
        harness.enable { $0.suggestPatches = false; $0.trigger = .manual }
        try harness.type(view, "旧港的钟楼塌了一半。")
        try harness.settle(view)
        AgentStubProtocol.reset([copilotElements([["name": "旧港", "category": "地点", "summary": "一座港口。", "evidence": "旧港的钟楼"]])])
        view.textView.copilotAnalyze(nil)
        try harness.waitRun()
        let port = try harness.suggestion("旧港")
        // 拒绝 on the 审阅 card.
        try wait { harness.reviewController.card(commentID: port.id) != nil }
        guard let portCard = harness.reviewController.card(commentID: port.id) else { throw LabError.message("审阅 lacks the suggestion") }
        try require(!portCard.acceptButton.isHidden && !portCard.rejectButton.isHidden && portCard.editButton.isHidden && portCard.resolveButton.isHidden
            && portCard.headerLabel.stringValue == "Copilot 建议 · 新设定 · 章节「北岸」 · 已定位", "The suggestion card differs: \(portCard.headerLabel.stringValue)")
        var mark = try harness.journal.mark()
        portCard.rejectButton.performClick(nil)
        try wait { harness.controller.deciding.isEmpty }
        try require((try harness.suggestion("旧港")).review == .converted, "拒绝 did not convert the suggestion")
        try harness.journal.expect([resolveOriginal], since: mark, "拒绝")
        let rejected = try harness.actions()
        try require(rejected.count == 1 && rejected[0].kind == "reject_suggestion" && rejected[0].commentId == port.id
            && AgentJSONText.object(rejected[0].payloadJson)?["name"] as? String == "旧港" && rejected[0].resultJson == nil,
            "The rejection was not recorded: \(rejected)")
        try require(harness.reviewController.card(commentID: port.id) == nil && harness.review.status == "已拒绝这条建议，Copilot 不会再提出它。",
            "A rejected suggestion stayed in the open list")

        // Existing names and aliases, rejected names, duplicates and missing
        // evidence are left out; an unknown category reads 未分类.
        try harness.type(view, "\n阿岚在旧港遇见了顾远，顾远背着一把铜钥匙。")
        try harness.settle(view)
        AgentStubProtocol.reset([copilotElements([
            ["name": "林岚", "category": "人物", "summary": "", "evidence": "阿岚在旧港"],
            ["name": "阿岚", "category": "人物", "summary": "", "evidence": "阿岚在旧港"],
            ["name": "旧港", "category": "地点", "summary": "", "evidence": "在旧港遇见"],
            ["name": "顾远", "category": "人物", "summary": "背着铜钥匙的人。", "evidence": "顾远背着一把铜钥匙"],
            ["name": "《顾远》", "category": "人物", "summary": "", "evidence": "遇见了顾远"],
            ["name": "铜钥匙", "category": "物件", "summary": "", "evidence": "“一把铜钥匙”"],
            ["name": "白鹭", "category": "人物", "summary": "", "evidence": "白鹭飞过屋檐"],
        ])])
        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.copilotAnalyze(nil)
        try harness.waitRun()
        let user = copilotPrompt(0).user
        try require(user.contains("【已有名称】林岚、阿岚") && user.contains("【作者拒绝过的名称】旧港")
            && user.contains("[1] 阿岚在旧港遇见了顾远，顾远背着一把铜钥匙。") && !user.contains("钟楼"),
            "The prompt lacks the names to leave out: \(user)")
        let open = try harness.suggestions().filter(\.isOpenSuggestion)
        let names = open.compactMap { comment -> String? in if case .element(let c)? = CopilotProposal(comment) { return c.name }; return nil }
        try require(names == ["顾远", "铜钥匙"], "The kept suggestions differ: \(names)")
        let traveller = try harness.suggestion("顾远"), key = try harness.suggestion("铜钥匙")
        guard case .element(let keyCandidate)? = CopilotProposal(key) else { throw LabError.message("铜钥匙 is not an element") }
        try require(keyCandidate.category == "未分类" && copilotQuote(view, traveller) == "顾远背着一把铜钥匙" && copilotQuote(view, key) == "一把铜钥匙",
            "Categories or anchors differ")
        try require(harness.controller.lastRun?.dropped.contains { $0.contains("原文里找不到依据「白鹭飞过屋檐」") } == true
            && harness.controller.lastRun?.created.count == 2 && harness.host.copilotStatus == "Copilot 已提出 2 条建议",
            "Missing evidence was not dropped: \(harness.controller.lastRun?.dropped ?? [])")

        // 审阅's Copilot filter and the chapter's 批注 panel.
        harness.review.filter = .copilot
        try require(Set(harness.review.openItems.map(\.comment.id)) == [traveller.id, key.id], "The Copilot filter differs")
        harness.review.filter = .notes
        try require(harness.review.openItems.isEmpty, "批注 listed Copilot suggestions")
        harness.review.filter = .all
        try require(harness.reviewController.filterControl.segmentCount == 4 && harness.reviewController.filterControl.label(forSegment: 3) == "Copilot",
            "审阅 lacks the Copilot filter")
        let model = ChapterCommentsModel()
        let panel = MacChapterCommentsViewController(model: model)
        panel.copilot = harness.reviewController.commands.copilot
        harness.commentsPanel = model
        _ = panel.view
        model.bind(view.binding.store)
        try wait { !model.busy && model.entries.count == 2 }
        try require(copilotFind("accept-comment-\(traveller.id)", in: panel.view) != nil && copilotFind("reject-comment-\(key.id)", in: panel.view) != nil
            && (copilotFind("comment-state-\(traveller.id)", in: panel.view) as? NSTextField)?.stringValue.hasPrefix("Copilot 建议") == true,
            "The 批注 panel lacks 接受 and 拒绝")

        // 未分类 asks for a category; 接受 from the menu writes the element there.
        guard let keyCard = harness.reviewController.card(commentID: key.id), let menu = keyCard.acceptMenu() else {
            throw LabError.message("未分类 did not ask for a category")
        }
        try require(menu.items.dropFirst().map(\.title) == ["人物", "地点"], "The category menu differs")
        mark = try harness.journal.mark()
        guard let place = menu.items.first(where: { $0.accessibilityIdentifier() == "review-accept-category-\(harness.categories["地点"]!.id)" }),
              let action = place.action else { throw LabError.message("The menu lacks 地点") }
        NSApp.sendAction(action, to: place.target, from: place)
        try wait { harness.controller.deciding.isEmpty }
        try harness.settle(view)
        let library = try harness.library()
        guard let keyElement = library.elements.first(where: { $0.name == "铜钥匙" }) else { throw LabError.message("铜钥匙 was not created") }
        try require(keyElement.categoryId == harness.categories["地点"]!.id, "铜钥匙 is not in the chosen category")
        let written = withoutLinks(try harness.journal.originals(since: mark))
        try require(written.count == 2 && written[0].contains("entity.create element") && written[1] == resolveOriginal, "接受 wrote \(written)")
        try wait { !model.busy && model.entries.map(\.id) == [traveller.id] }

        // Usage is kept beside the assistant's and listed in 用量.
        harness.controller.store.flush()
        let usage = harness.controller.usage
        let file = harness.controller.store.directory.appendingPathComponent(AgentConversationStore.copilotUsageFile)
        let saved = try AgentConversationStore.decoder().decode(CopilotUsageFile.self, from: Data(contentsOf: file))
        try require(usage.count == 2 && usage.allSatisfy { $0.purpose == .copilot && $0.provider == .deepseek && $0.inputTokens == 320 && $0.outputTokens == 48 }
            && saved.usage.map(\.id) == usage.map(\.id) && saved.usage.map(\.inputTokens) == usage.map(\.inputTokens)
            && AgentConversationStore(root: harness.workspace.agentDirectory, projectID: harness.project.id).load().isEmpty,
            "Copilot usage was not recorded apart from conversations: \(usage)")
        let row = CopilotController.usageConversation(projectID: harness.project.id, usage: usage)!
        let pane = MacAgentSettingsViewController()
        pane.source = { (harness.project.name, [row]) }
        _ = pane.view
        try require(pane.todayLabel.stringValue == "输入 640（缓存 0）· 输出 96 · 2 次请求"
            && pane.conversationsStack.arrangedSubviews.map { $0.accessibilityIdentifier() } == ["settings-agent-usage-conversation-copilot"]
            && pane.conversationsStack.arrangedSubviews.first?.accessibilityLabel()?.hasPrefix("Copilot（实验）") == true,
            "用量 does not list Copilot: \(pane.todayLabel.stringValue)")
        try harness.close()
    }

    // MARK: (d) Patch suggestions, 接受, 拒绝 and refusals

    private static func copilotPatchesAndReview() throws {
        let harness = try CopilotHarness(titles: ["雨夜"], categories: ["人物", "地点"],
                                         elements: [("林岚", "人物", ["阿岚"]), ("北塔", "地点", [])])
        defer { harness.remove() }
        let lan = harness.elements["林岚"]!, tower = harness.elements["北塔"]!
        let existing: WorkspacePatchReply<WorkspacePatch> = try elementResult {
            harness.workspace.createPatch(projectID: harness.project.id, elementID: lan.id, title: "成为守灯人", body: "接替了老守灯人。",
                                          source: nil, completion: $0)
        }
        try require(existing.result != nil, "The existing patch was not written")
        let view = try harness.open(0)
        let chapterID = harness.chapters[0].id
        harness.enable { $0.trigger = .manual }
        try harness.type(view, "阿岚忘了回家的路。")
        try harness.settle(view)
        // A first run proposes a change the author rejects.
        AgentStubProtocol.reset([copilotElements([]),
                                 copilotPatches([["elementId": lan.id, "title": "失去记忆", "body": "记不起回家的路。", "evidence": "忘了回家的路"]])])
        view.textView.copilotAnalyze(nil)
        try harness.waitRun()
        try require(AgentStubProtocol.requests.count == 2 && copilotPrompt(1).system == CopilotPrompt.patchSystem, "The patch task did not run")
        let memory = try harness.suggestion("失去记忆")
        harness.controller.reject(memory)
        try wait { harness.controller.deciding.isEmpty }

        try harness.type(view, "\n林岚在北塔被落石砸伤了左臂，沈舟把她背下了楼。")
        try harness.settle(view)
        AgentStubProtocol.reset([
            copilotElements([["name": "沈舟", "category": "人物", "summary": "渡口的船夫。", "evidence": "沈舟把她背下了楼"]]),
            copilotPatches([
                ["elementId": lan.id, "title": "左臂受伤", "body": "在北塔被落石砸伤了左臂。", "evidence": "被落石砸伤了左臂"],
                ["elementId": lan.id, "title": "成为守灯人", "body": "又一次。", "evidence": "林岚在北塔"],
                ["elementId": lan.id, "title": "失去记忆", "body": "记不起。", "evidence": "林岚在北塔"],
                ["elementId": "element-unknown", "title": "不存在", "body": "x", "evidence": "林岚在北塔"],
                ["element": "北塔", "title": "塔楼受损", "body": "", "evidence": "落石"],
            ]),
        ])
        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.copilotAnalyze(nil)
        try harness.waitRun()
        let patchPrompt = copilotPrompt(1).user
        try require(patchPrompt.contains("- 编号 \(lan.id)：林岚（别名：阿岚；人物）") && patchPrompt.contains("已有补丁：成为守灯人")
            && patchPrompt.contains("- 编号 \(tower.id)：北塔（地点）") && patchPrompt.contains("【作者拒绝过的补丁】\n- 林岚：失去记忆")
            && patchPrompt.contains("[1] 林岚在北塔被落石砸伤了左臂，沈舟把她背下了楼。") && !patchPrompt.contains("回家的路"),
            "The patch prompt differs: \(patchPrompt)")
        let open = try harness.suggestions().filter(\.isOpenSuggestion)
        try require(open.count == 3 && harness.host.copilotStatus == "Copilot 已提出 3 条建议", "Open suggestions differ: \(open.map(\.bodyText))")
        let injury = try harness.suggestion("左臂受伤"), damage = try harness.suggestion("塔楼受损"), ferryman = try harness.suggestion("沈舟")
        guard case .patch(let injuryCandidate)? = CopilotProposal(injury), case .patch(let damageCandidate)? = CopilotProposal(damage) else {
            throw LabError.message("The patch metadata differs")
        }
        try require(injuryCandidate.elementID == lan.id && injuryCandidate.elementName == "林岚" && damageCandidate.elementID == tower.id
            && injury.bodyText == "设定补丁「林岚」：左臂受伤\n\n在北塔被落石砸伤了左臂。" && copilotQuote(view, injury) == "被落石砸伤了左臂",
            "The patch suggestion differs: \(injury.bodyText)")
        let injuryCard = harness.reviewController.card(commentID: injury.id)
        try require(injuryCard?.headerLabel.stringValue.hasPrefix("Copilot 建议 · 设定补丁") == true && injuryCard?.acceptMenu() == nil,
            "The patch card differs")

        // 接受 the element: one create, one decision.
        var mark = try harness.journal.mark()
        harness.reviewController.card(commentID: ferryman.id)?.acceptButton.performClick(nil)
        try wait { harness.controller.deciding.isEmpty }
        try harness.settle(view)
        let written = withoutLinks(try harness.journal.originals(since: mark))
        try require(written.count == 2 && written[0].contains("entity.create element") && !written[0].contains { $0.hasSuffix(" comment") }
            && written[1] == resolveOriginal, "接受 of an element wrote \(written)")
        guard let shen = try harness.library().elements.first(where: { $0.name == "沈舟" }) else { throw LabError.message("沈舟 was not created") }
        try require(shen.categoryId == harness.categories["人物"]!.id && shen.summary == "渡口的船夫。", "沈舟's category or summary differs")
        var decisions = try harness.actions()
        try require(decisions.last?.kind == "accept_suggestion" && decisions.last?.commentId == ferryman.id
            && decisions.last?.resultJson.flatMap { AgentJSONText.object($0) }?["elementId"] as? String == shen.id,
            "The acceptance was not recorded with the element: \(decisions)")
        try require(harness.effects.contains { if case .elements = $0 { return true }; return false }, "The library did not follow")

        // 接受 the patch: anchored to the evidence in its chapter.
        mark = try harness.journal.mark()
        harness.reviewController.card(commentID: injury.id)?.acceptButton.performClick(nil)
        try wait { harness.controller.deciding.isEmpty }
        try harness.journal.expect([["entity.create element-patch", "order.move element-patch"], resolveOriginal], since: mark, "接受 of a patch")
        let lanPatches = try harness.patches(lan.id)
        guard let created = lanPatches.first(where: { $0.title == "左臂受伤" }) else { throw LabError.message("The patch was not created") }
        try require(created.body == "在北塔被落石砸伤了左臂。" && created.sourceNodeId == chapterID && created.anchorText == "被落石砸伤了左臂"
            && created.sourceBlockId != nil && created.sourceBlockText?.contains("被落石砸伤了左臂") == true && !created.isInvalid,
            "The patch is not anchored to the evidence: \(created)")
        decisions = try harness.actions()
        try require(decisions.last?.resultJson.flatMap { AgentJSONText.object($0) }?["patchId"] as? String == created.id
            && harness.effects.contains { if case .patches(_, let id) = $0 { return id == lan.id }; return false },
            "The patch acceptance was not recorded")
        // Decided suggestions leave the open lists.
        try require(harness.reviewController.card(commentID: injury.id) == nil && harness.reviewController.card(commentID: ferryman.id) == nil
            && harness.review.openItems.map(\.comment.id) == [damage.id], "Decided suggestions stayed open")

        // A refused create leaves the suggestion open with the reason.
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            harness.workspace.trashElement(projectID: harness.project.id, elementID: tower.id, completion: $0)
        }
        mark = try harness.journal.mark()
        harness.reviewController.card(commentID: damage.id)?.acceptButton.performClick(nil)
        try wait { harness.controller.deciding.isEmpty }
        try harness.journal.expect([], since: mark, "A refused patch")
        try require((try harness.suggestion("塔楼受损")).review == .open
            && harness.controller.failures[damage.id] == "设定「北塔」已不可用（可能已移到回收站），补丁没有创建。"
            && harness.reviewController.card(commentID: damage.id)?.suggestionMessage.stringValue == harness.controller.failures[damage.id]
            && harness.review.status == harness.controller.failures[damage.id], "The refusal was not shown on an open suggestion")
        // Rust's own refusal: the name was taken meanwhile.
        try harness.type(view, "\n灯下站着许青。")
        try harness.settle(view)
        AgentStubProtocol.reset([copilotElements([["name": "许青", "category": "人物", "summary": "", "evidence": "灯下站着许青"]]), copilotPatches([])])
        view.textView.copilotAnalyze(nil)
        try harness.waitRun()
        let stranger = try harness.suggestion("许青")
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            harness.workspace.createElement(projectID: harness.project.id, categoryID: harness.categories["人物"]!.id, name: "许青", completion: $0)
        }
        try harness.settle(view)
        mark = try harness.journal.mark()
        harness.controller.accept(stranger)
        try wait { harness.controller.deciding.isEmpty }
        try harness.journal.expect([], since: mark, "A refused element")
        try require((try harness.suggestion("许青")).review == .open && (harness.controller.failures[stranger.id] ?? "").contains("许青"),
            "Rust's refusal did not keep the suggestion open: \(harness.controller.failures[stranger.id] ?? "")")
        // 拒绝 afterwards works and is one original.
        mark = try harness.journal.mark()
        harness.reviewController.card(commentID: stranger.id)?.rejectButton.performClick(nil)
        try wait { harness.controller.deciding.isEmpty }
        try harness.journal.expect([resolveOriginal], since: mark, "拒绝 after a refusal")
        try require(harness.controller.failures[stranger.id] == nil && (try harness.suggestion("许青")).review == .converted, "拒绝 did not decide it")
        try harness.close()
    }

    // MARK: (e) Typing, one request, closing, retries and errors

    private static func copilotCancellation() throws {
        let harness = try CopilotHarness(titles: ["启程", "航行"], categories: ["人物"])
        defer { harness.remove() }
        var view = try harness.open(0)
        harness.enable { $0.suggestPatches = false; $0.trigger = .manual }
        try harness.type(view, "沈舟在渡口等她。")
        try harness.settle(view)
        var held = copilotElements([["name": "沈舟", "category": "人物", "summary": "", "evidence": "沈舟在渡口"]])
        held.hold = true
        AgentStubProtocol.reset([held])
        view.textView.copilotAnalyze(nil)
        try wait { AgentStubProtocol.requests.count == 1 }
        try require(harness.controller.isRunning && harness.host.copilotStatus == "Copilot 正在分析…", "The run did not start")
        // Typing is never held while the request is out.
        try harness.type(view, "\n她提着灯。")
        try harness.settle(view)
        try require(view.textView.string.hasSuffix("她提着灯。") && harness.controller.isRunning, "Typing waited for Copilot")
        // One request at a time.
        try require(!view.canRequestCopilot && !harness.controller.analyze(kind: .chapter, id: harness.chapters[0].id, store: view.binding.store,
                                                                            selection: nil), "A second run started")
        pumpCopilot(0.2)
        try require(AgentStubProtocol.requests.count == 1, "A second request was sent")
        // Closing the chapter stops the request; nothing is added.
        let stopped = AgentStubProtocol.stopped
        let closed: Bool = try elementResult {
            harness.host.closeTab(pane: 0, scope: .chapter(ChapterScope(projectID: harness.project.id, chapterID: harness.chapters[0].id)), completion: $0)
        }
        try require(closed && !harness.controller.isRunning && harness.statuses.last == .cancelled
            && harness.host.copilotStatus == "Copilot 已停止：页面已关闭", "Closing did not stop the run: \(harness.statuses)")
        try wait { AgentStubProtocol.stopped > stopped }
        pumpCopilot(0.3)
        try require(try harness.suggestions().isEmpty && harness.controller.usage.isEmpty, "A stopped run added a suggestion or usage")

        // Retries follow the assistant's policy.
        view = try harness.open(1)
        try harness.type(view, "许青推开了门。")
        try harness.settle(view)
        AgentStubProtocol.reset([AgentSSE.error(503, "busy"), copilotElements([["name": "许青", "category": "人物", "summary": "", "evidence": "许青推开了门"]])])
        view.textView.copilotAnalyze(nil)
        try harness.waitRun()
        try require(AgentStubProtocol.requests.count == 2 && harness.statuses.contains(.retrying(attempt: 1, of: 3))
            && harness.statuses.last == .proposed(1), "503 was not retried: \(harness.statuses)")
        try harness.type(view, "\n门外下着雨。")
        try harness.settle(view)
        AgentStubProtocol.reset([AgentSSE.error(401, "bad key"), copilotElements([])])
        view.textView.copilotAnalyze(nil)
        try harness.waitRun()
        try require(AgentStubProtocol.requests.count == 1 && AgentStubProtocol.remaining == 1
            && harness.host.copilotStatus?.hasPrefix("Copilot 出错：DeepSeek 拒绝了这个 API Key（HTTP 401）") == true,
            "401 was retried or not reported: \(harness.host.copilotStatus ?? "")")
        // A failed run leaves its paragraphs for the next one.
        AgentStubProtocol.reset([copilotElements([])])
        view.textView.copilotAnalyze(nil)
        try harness.waitRun()
        try require(copilotPrompt(0).user.contains("[1] 门外下着雨。"), "A failed run consumed its paragraphs")
        // A missing key is reported without a request.
        try harness.credentials.removeKey(for: .deepseek)
        try harness.type(view, "\n雨停了。")
        try harness.settle(view)
        AgentStubProtocol.reset([])
        view.textView.copilotAnalyze(nil)
        try require(AgentStubProtocol.requests.isEmpty && !harness.controller.isRunning
            && harness.host.copilotStatus == "Copilot 出错：还没有设置 DeepSeek 的 API Key。请在 设置 › Copilot（实验）中管理 API Key。",
            "A missing key was not reported: \(harness.host.copilotStatus ?? "")")
        try harness.close()
    }

    // MARK: (f) Drifts

    private static func copilotDrifts() throws {
        let harness = try CopilotHarness(titles: ["启程"], categories: ["人物"])
        defer { harness.remove() }
        let created: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            harness.workspace.createDrift(projectID: harness.project.id, title: "旧信", groupID: nil, completion: $0)
        }
        guard let drift = created.result else { throw LabError.message("The drift was not created") }
        try wait { harness.host.canNavigate && !harness.host.isBusy }
        let view: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, drift: drift, completion: $0) }
        try harness.settle(view)
        harness.enable { $0.suggestPatches = false }
        AgentStubProtocol.reset([])
        try harness.type(view, "信里提到一个叫周渡的人。")
        pumpCopilot(0.8)
        try require(AgentStubProtocol.requests.isEmpty && !view.canRequestCopilot
            && !(try harness.contextMenu(view, at: 0)).items.contains { $0.accessibilityIdentifier() == "context-copilot-analyze" },
            "Copilot ran in a drift without 在灵感中启用")
        // 在灵感中启用.
        harness.enable { $0.suggestPatches = false; $0.inDrifts = true }
        AgentStubProtocol.reset([copilotElements([["name": "周渡", "category": "人物", "summary": "", "evidence": "一个叫周渡的人"]])])
        try harness.type(view, "\n周渡住在河对岸。")
        try wait { AgentStubProtocol.requests.count == 1 }
        try harness.waitRun()
        let user = copilotPrompt(0).user
        try require(user.contains("[1] 周渡住在河对岸。") && !user.contains("[2]"), "The drift's changed paragraph was not sent: \(user)")
        try require(harness.controller.lastRun?.kind == .drift && harness.controller.lastRun?.bodyID == drift.id, "The run was not the drift's")
        // The suggestion is anchored in the drift body like a chapter's.
        let stored = try harness.suggestions()
        try require(harness.controller.lastRun?.created.count == 1 && stored.count == 1
            && stored[0].targetId == drift.id && harness.host.copilotStatus == "Copilot 已提出 1 条建议",
            "The drift suggestion's outcome differs: \(harness.host.copilotStatus ?? "") \(stored.map(\.targetId))")
        // Turning it off stops a drift run.
        var held = copilotElements([])
        held.hold = true
        AgentStubProtocol.reset([held])
        try harness.type(view, "\n河上起了雾。")
        try harness.settle(view)
        view.textView.copilotAnalyze(nil)
        try wait { AgentStubProtocol.requests.count == 1 && harness.controller.isRunning }
        harness.enable { $0.suggestPatches = false; $0.inDrifts = false }
        try require(!harness.controller.isRunning && !view.canRequestCopilot, "Turning 在灵感中启用 off did not stop the drift run")
        try harness.close()
    }
}
