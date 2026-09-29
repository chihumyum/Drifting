import AppKit

/// 设置 › 编辑器's 光标颜色, 链接样式 and Tab 缩进, chapter hover previews in
/// the chapter list and the 整书大纲, the status line's 主线 total, the
/// 全书长卷's shared controls and the first-run 欢迎使用, through the real
/// settings store and window, tab host, editors, 全书长卷, 历史版本 sheet,
/// outline panel, Rust workspace and SQLite, wired as AppDelegate wires them.
/// Windows are never on screen; every name and body is synthetic.
extension BindingAcceptance {
    static let polishCases = [
        "AppKit 设置 › 编辑器 光标颜色 follows the 界面强调色 (the system accent without one) or a chosen colour in every editor, a hidden tab and the 全书长卷, and Tab 缩进 of one to four characters sets every indented block's paragraph style; both save to settings.json at once, read back cold, clamp hand-edited values, and 还原推荐样式 returns Tab 缩进 to two",
        "AppKit 设置 › 编辑器 链接样式 restyles entity links at once in every editor (a hidden tab too), the 全书长卷's editors and read-only rows and the 历史版本 preview: 按分类着色 in the element's category colour and the default blue, 按类型着色 in the per-kind colours with a 类型颜色 row that edits and resets them, 仅悬停时显示 as prose until the pointer rests on a link (the whole link shown in its category colour, restored when it leaves or before typing), and 不着色 in the prose colour with a grey underline; text, selection, revision and history stay and nothing is journaled; the choice saves to settings.json and reads back cold",
        "AppKit chapter hover previews: resting on a chapter row in the chapter list or the 整书大纲 shows, after the delay, a popover card with the chapter's title, 写作状态, word count and 摘要 (暂无摘要 when empty, no 点击打开); another row replaces it, leaving or an act row shows none, a trashed list has none, and reading writes nothing",
        "AppKit status line names the active chapter's 主线 and that storyline's word total beside 当前 and 全书 (主线「北境」1,234 字, 统计中… while a member is uncounted), following typing in the chapter, a membership change, a storyline rename and a chapter without storylines",
        "AppKit 全书长卷 has one set of 撤销 … 链接… controls instead of each row's: they follow the chapter whose editor takes the keyboard (named in the bar), act on that chapter only (加粗, 段落样式, 撤销, 增加缩进) while the other chapters stay as they were, and turn off once that editor leaves",
        "AppKit 欢迎使用 opens at launch only while the lab has no projects and 不再显示 is unchecked (the project selected last opens instead, else the 项目书架), says what Drifting is and where the book is kept, offers 新建项目 and 导入… after ending the sheet, and keeps 不再显示 in settings.json at once through a cold relaunch",
    ]

    static func polishAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, WordCountModel.refreshDelay,
                     MacWholeBookViewController.typingPause, MacWholeBookViewController.retryDelay, TableHoverPreview.delay,
                     MacWholeBookViewController.maximumAttached)
        defer {
            (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, WordCountModel.refreshDelay,
             MacWholeBookViewController.typingPause, MacWholeBookViewController.retryDelay, TableHoverPreview.delay,
             MacWholeBookViewController.maximumAttached) = saved
            LabSettingsStore.restoreUnconfigured()
        }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        WordCountModel.refreshDelay = 0.05
        MacWholeBookViewController.typingPause = 0.2
        MacWholeBookViewController.retryDelay = 0.05
        TableHoverPreview.delay = 0.05
        try polishCaretAndIndent()
        try polishLinkStyles()
        try polishHoverPreviews()
        try polishStatusLine()
        try polishWholeBookControls()
        try polishWelcome()
        return polishCases
    }

    // MARK: Harness

    private final class PolishHarness {
        let root: URL
        let directory: URL
        let journal: JournalProbe
        let workspace: LabWorkspaceCore
        let settings: LabSettingsStore
        let window: NSWindow
        let host: MacChapterWorkspace

        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            workspace = LabWorkspaceCore(directory: directory)
            settings = LabSettingsStore(directory: root)
            (window, host) = BindingAcceptance.elementHost(workspace)
            let workspace = self.workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "The polish fixture was not isolated")
        }

        func project(_ name: String) throws -> WorkspaceProject {
            let workspace = self.workspace
            return try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
        }

        func chapter(_ project: WorkspaceProject, _ title: String, _ paragraphs: [String] = []) throws -> WorkspaceChapter {
            let workspace = self.workspace
            if paragraphs.isEmpty {
                return try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
            }
            let imported: WorkspaceImportedEntity = try BindingAcceptance.elementResult {
                workspace.importBlocks(projectID: project.id, title: title, target: .chapter, blocks: paragraphs.map { .paragraph($0) }, completion: $0)
            }
            guard case .chapter(let chapter) = imported else { throw LabError.message("\(title) was not imported as a chapter") }
            return chapter
        }

        /// A category, an element in it, and every name linkable in open bodies.
        func person(_ project: WorkspaceProject, _ name: String) throws -> (WorkspaceElementCategory, WorkspaceElement) {
            let workspace = self.workspace
            let category: WorkspaceElementReply<WorkspaceElementCategory> = try BindingAcceptance.elementResult {
                workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
            }
            let element: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                workspace.createElement(projectID: project.id, categoryID: category.result!.id, name: name, completion: $0)
            }
            host.applyElementLibrary(projectID: project.id, library: element.library)
            return (category.result!, element.result!)
        }

        func settled(_ views: NativeDocumentView..., file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) {
                !self.host.isBusy && self.host.canNavigate && views.allSatisfy {
                    $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks && !$0.binding.store.isLinking
                }
            }
        }

        @discardableResult
        func open(_ project: WorkspaceProject, _ chapter: WorkspaceChapter) throws -> NativeDocumentView {
            let host = self.host
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, chapter: chapter, in: 0, completion: $0) }
            try settled(view)
            window.contentView?.layoutSubtreeIfNeeded()
            return view
        }

        func type(_ view: NativeDocumentView, _ text: String, at location: Int? = nil) throws {
            let at = location ?? (view.textView.string as NSString).length
            view.textView.setSelectedRange(NSRange(location: at, length: 0))
            view.textView.insertText(text, replacementRange: NSRange(location: at, length: 0))
            try settled(view)
        }

        func settingsJSON() throws -> [String: Any] {
            (try JSONSerialization.jsonObject(with: Data(contentsOf: settings.fileURL)) as? [String: Any]) ?? [:]
        }

        /// A 全书长卷 of the project in its own window, as AppDelegate opens it.
        func book(_ project: WorkspaceProject) throws -> (MacWholeBookViewController, NSWindow) {
            let model = WholeBookModel(workspace: workspace, projectID: project.id)
            let book = MacWholeBookViewController(project: project, model: model, workspace: workspace, host: host)
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 760), styleMask: [.titled, .resizable],
                                  backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentViewController = book
            window.setContentSize(NSSize(width: 1000, height: 760))
            book.view.layoutSubtreeIfNeeded()
            host.wordCounts(projectID: project.id)
            model.load()
            try BindingAcceptance.wait { model.loaded && book.isSettled && self.host.canNavigate }
            book.documentView.layoutSubtreeIfNeeded()
            return (book, window)
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let host = self.host
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "The polish workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: root) }
    }

    private static func polishHex(_ color: Any?) -> String? { (color as? NSColor).map(MacAppearanceSettingsViewController.hex) }

    private static func polishPick(_ control: NSSegmentedControl, _ segment: Int) {
        control.selectedSegment = segment
        control.sendAction(control.action, to: control.target)
    }

    /// The first view below `root` with the accessibility identifier.
    private static func polishFind(_ root: NSView, _ identifier: String) -> NSView? {
        if root.accessibilityIdentifier() == identifier { return root }
        for child in root.subviews { if let found = polishFind(child, identifier) { return found } }
        return nil
    }

    // MARK: (a) 光标颜色 and Tab 缩进

    private static func polishCaretAndIndent() throws {
        let harness = try PolishHarness()
        defer { harness.remove() }
        defer { LabSettingsStore.restoreUnconfigured() }
        let store = harness.settings
        store.apply()
        let project = try harness.project("光标合成项目")
        let hiddenChapter = try harness.chapter(project, "隐藏", ["藏在后面的标签。"])
        let chapter = try harness.chapter(project, "夜港", ["灯塔一明一灭。", "潮水拍着石阶。", "第三段。"])
        let hidden = try harness.open(project, hiddenChapter)
        let view = try harness.open(project, chapter)
        let settingsWindow = MacSettingsWindowController(store: store)
        defer { settingsWindow.window?.close() }
        let pane = settingsWindow.editorPane, appearance = settingsWindow.appearancePane
        _ = pane.view; _ = appearance.view
        pane.refresh(); appearance.refresh()
        // The pane grew with these rows: it scrolls instead of outgrowing a small screen.
        let scroll = pane.view.subviews.compactMap { $0 as? NSScrollView }.first
        try require(pane.view.fittingSize.height <= 700.5 && (scroll?.documentView?.fittingSize.height ?? 0) > pane.view.fittingSize.height
            && scroll.map { polishFind($0, "settings-caret-mode") === pane.caretModeControl } == true,
            "The 编辑器 pane does not scroll: \(pane.view.fittingSize.height) / \(scroll?.documentView?.fittingSize.height ?? 0)")

        // 跟随强调色 by default: the system accent, then a chosen 界面强调色.
        try require(store.settings.caretColor == nil && pane.caretModeControl.selectedSegment == 0 && !pane.caretWell.isEnabled
            && pane.caretValue.stringValue == "系统强调色" && view.textView.insertionPointColor == .controlAccentColor
            && hidden.textView.insertionPointColor == .controlAccentColor, "The caret does not follow the system accent by default")
        appearance.accentWell.color = NSColor(srgbRed: 0.8, green: 0.2, blue: 0.2, alpha: 1)
        appearance.accentChanged()
        let accent = store.settings.accentColor
        try require(accent == "#CC3333" && polishHex(view.textView.insertionPointColor) == "#CC3333"
            && polishHex(hidden.textView.insertionPointColor) == "#CC3333" && pane.caretValue.stringValue == "界面强调色 #CC3333",
            "The caret did not follow the 界面强调色: \(polishHex(view.textView.insertionPointColor) ?? "none")")
        // 自定义 starts from the renderer's caret colour, then a chosen one.
        let text = view.textView.string, selection = NSRange(location: 2, length: 3)
        view.textView.setSelectedRange(selection)
        let revision = view.binding.store.projection?.revision
        var mark = try harness.journal.mark()
        polishPick(pane.caretModeControl, 1)
        try require(store.settings.caretColor == "#6B7FA6" && pane.caretWell.isEnabled && pane.caretValue.stringValue == "#6B7FA6"
            && polishHex(view.textView.insertionPointColor) == "#6B7FA6" && polishHex(hidden.textView.insertionPointColor) == "#6B7FA6",
            "自定义 did not start from #6B7FA6")
        pane.caretWell.color = NSColor(srgbRed: 0.2, green: 0.6, blue: 0.4, alpha: 1)
        pane.caretColorChanged()
        let chosen = MacAppearanceSettingsViewController.hex(pane.caretWell.color)
        try require(store.settings.caretColor == chosen && polishHex(view.textView.insertionPointColor) == chosen
            && polishHex(hidden.textView.insertionPointColor) == chosen, "The chosen caret colour did not reach every editor")
        // The 全书长卷's editors take it too.
        let (book, bookWindow) = try harness.book(project)
        defer { bookWindow.close() }
        guard let bookEditor = book.chapterRow(chapter.id)?.editor else { throw LabError.message("The 全书长卷 attached no editor") }
        try require(polishHex(bookEditor.textView.insertionPointColor) == chosen, "The 全书长卷's editor has another caret colour")
        var json = try harness.settingsJSON()
        try require(json["caretColor"] as? String == chosen && LabSettingsStore(directory: harness.root).settings.caretColor == chosen,
            "settings.json or a cold store lacks the caret colour")
        try require(view.textView.string == text && view.textView.selectedRange() == selection
            && view.binding.store.projection?.revision == revision, "A caret colour changed the text, selection or revision")
        try harness.journal.expect([], since: mark, "Caret colours")
        // 跟随强调色 again forgets the chosen colour.
        polishPick(pane.caretModeControl, 0)
        try require(store.settings.caretColor == nil && !pane.caretWell.isEnabled && polishHex(view.textView.insertionPointColor) == "#CC3333"
            && polishHex(bookEditor.textView.insertionPointColor) == "#CC3333", "跟随强调色 did not return the caret to the accent")
        json = try harness.settingsJSON()
        try require(json["caretColor"] == nil, "跟随强调色 left a caret colour in settings.json")
        appearance.resetAccent()
        try require(view.textView.insertionPointColor == .controlAccentColor, "Resetting the accent left the caret coloured")

        // Tab 缩进: one indent level is the chosen number of characters.
        let second = (view.textView.string as NSString).range(of: "潮水").location
        view.binding.format(.indentIncrease, range: NSRange(location: second, length: 0))
        try harness.settled(view)
        func indent() -> (CGFloat, CGFloat)? {
            guard let style = view.textView.textStorage?.attribute(.paragraphStyle, at: second, effectiveRange: nil) as? NSParagraphStyle else { return nil }
            return (style.headIndent, style.firstLineHeadIndent)
        }
        let size = DocumentStyle.typography.size
        try require(store.settings.indentStep == 2 && DocumentStyle.typography.indentStep == 2 && indent()?.0 == size * 2
            && pane.indentStepControl.selectedSegment == 1 && pane.indentStepControl.label(forSegment: 3) == "4 字符",
            "The default Tab 缩进 is not two characters: \(String(describing: indent()))")
        mark = try harness.journal.mark()
        polishPick(pane.indentStepControl, 3)
        try require(store.settings.indentStep == 4 && DocumentStyle.typography.indentStep == 4 && indent()?.0 == size * 4
            && indent()?.1 == size * 4 && DocumentStyle.indentWidth(1, size: size, step: DocumentStyle.typography.indentStep) == size * 4,
            "Tab 缩进 4 did not reach the paragraph: \(String(describing: indent()))")
        try require(view.binding.store.projection?.blocks.first { $0.range.location == second }?.indent == 1,
            "Tab 缩进 changed the stored indent level")
        polishPick(pane.indentStepControl, 0)
        try require(indent()?.0 == size, "Tab 缩进 1 did not reach the paragraph")
        try harness.journal.expect([], since: mark, "Tab 缩进")
        json = try harness.settingsJSON()
        try require(json["indentStep"] as? Int == 1 && LabSettingsStore(directory: harness.root).settings.indentStep == 1,
            "settings.json lacks Tab 缩进")
        store.resetTypesetting()
        try require(store.settings.indentStep == 2 && indent()?.0 == size * 2 && pane.indentStepControl.selectedSegment == 1,
            "还原推荐样式 did not return Tab 缩进 to two")

        // Hand-edited values fall back one by one.
        json = try harness.settingsJSON()
        json["caretColor"] = "red"; json["indentStep"] = 9; json["entityLinkStyle"] = "闪烁"; json["welcomeHidden"] = "是"
        json["entityLinkColors"] = ["element": "blue", "patch": "#112233", "chapter": "#5b93c7", "drift": "#1a2b3c"]
        try JSONSerialization.data(withJSONObject: json).write(to: store.fileURL)
        let edited = LabSettingsStore(directory: harness.root).settings
        try require(edited.caretColor == nil && edited.indentStep == 4 && edited.entityLinkStyle == .contextual && !edited.welcomeHidden
            && edited.entityLinkColors == ["drift": "#1A2B3C"],
            "Hand-edited values were read as \(String(describing: edited.caretColor)) \(edited.indentStep) \(edited.entityLinkStyle) \(edited.entityLinkColors)")
        try require(book.shutdown(), "The 全书长卷 did not shut down")
        try wait { book.isShutDown }
        try harness.close()
    }

    // MARK: (b) 链接样式

    private static func polishLinkStyles() throws {
        let harness = try PolishHarness()
        defer { harness.remove() }
        defer { LabSettingsStore.restoreUnconfigured() }
        let store = harness.settings
        store.apply()
        let workspace = harness.workspace
        let project = try harness.project("链接样式合成项目")
        let (people, kai) = try harness.person(project, "林凯")
        let homecoming = try harness.chapter(project, "归航")
        let _: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: project.id, title: "潮汐", groupID: nil, completion: $0)
        }
        let rain = try harness.chapter(project, "雨夜", ["林凯走上码头，想起归航和潮汐。", "第二段落在后面。"])
        harness.host.chaptersChanged(projectID: project.id)
        harness.host.driftsChanged(projectID: project.id)
        harness.host.elementsChanged(projectID: project.id)
        let hidden = try harness.open(project, homecoming)
        try harness.type(hidden, "林凯回来了。")
        let view = try harness.open(project, rain)
        let shown = view.textView.string as NSString
        let kaiAt = shown.range(of: "林凯").location, homeAt = shown.range(of: "归航").location, tideAt = shown.range(of: "潮汐").location
        try wait {
            view.linkTargets(at: kaiAt).first?.id == kai.id && view.linkTargets(at: homeAt).first?.kind == .chapter
                && view.linkTargets(at: tideAt).first?.kind == .drift && hidden.linkTargets(at: 0).first?.id == kai.id
        }
        try harness.settled(view, hidden)
        let settingsWindow = MacSettingsWindowController(store: store)
        defer { settingsWindow.window?.close() }
        let pane = settingsWindow.editorPane
        _ = pane.view
        pane.refresh()
        func attribute(_ key: NSAttributedString.Key, _ index: Int, in target: NativeDocumentView? = nil) -> Any? {
            (target ?? view).textView.textStorage?.attribute(key, at: index, effectiveRange: nil)
        }
        func underline(_ index: Int, in target: NativeDocumentView? = nil) -> Int? { attribute(.underlineStyle, index, in: target) as? Int }
        let category = people.color.uppercased()
        let single = NSUnderlineStyle.single.rawValue

        // 按分类着色, the default.
        try require(store.settings.entityLinkStyle == .contextual && pane.linkStyleControl.selectedSegment == 0
            && pane.writingGrid?.row(at: MacEditorSettingsViewController.linkColorRow).isHidden == true
            && polishHex(attribute(.foregroundColor, kaiAt)) == category && underline(kaiAt) == single
            && attribute(.foregroundColor, homeAt) as? NSColor == .systemBlue && attribute(.foregroundColor, tideAt) as? NSColor == .systemBlue,
            "按分类着色 differs: \(polishHex(attribute(.foregroundColor, kaiAt)) ?? "none") for \(category)")
        let text = view.textView.string, selection = NSRange(location: 3, length: 2)
        view.textView.setSelectedRange(selection)
        let revision = view.binding.store.projection?.revision, canUndo = view.binding.store.projection?.canUndo
        let mark = try harness.journal.mark()

        // 按类型着色 with its 类型颜色 row.
        polishPick(pane.linkStyleControl, 1)
        try require(store.settings.entityLinkStyle == .kind && DocumentStyle.linkStyle.mode == .kind
            && pane.writingGrid?.row(at: MacEditorSettingsViewController.linkColorRow).isHidden == false
            && polishHex(attribute(.foregroundColor, kaiAt)) == "#8B72C6" && polishHex(attribute(.foregroundColor, homeAt)) == "#5B93C7"
            && polishHex(attribute(.foregroundColor, tideAt)) == "#9B6BAA" && underline(homeAt) == single
            && polishHex(attribute(.foregroundColor, 0, in: hidden)) == "#8B72C6"
            && pane.linkColorValues.map(\.stringValue) == ["#8B72C6", "#5B93C7", "#9B6BAA"] && !pane.linkColorReset.isEnabled,
            "按类型着色 differs: \(polishHex(attribute(.foregroundColor, kaiAt)) ?? "none") \(polishHex(attribute(.foregroundColor, homeAt)) ?? "none")")
        pane.linkColorWells[0].color = NSColor(srgbRed: 0.1, green: 0.5, blue: 0.3, alpha: 1)
        pane.linkColorChanged(pane.linkColorWells[0])
        let element = MacAppearanceSettingsViewController.hex(pane.linkColorWells[0].color)
        try require(store.settings.entityLinkColors == ["element": element] && polishHex(attribute(.foregroundColor, kaiAt)) == element
            && polishHex(attribute(.foregroundColor, 0, in: hidden)) == element && pane.linkColorReset.isEnabled
            && pane.linkColorValues[0].stringValue == element, "A 类型颜色 did not reach the links")
        var json = try harness.settingsJSON()
        try require(json["entityLinkStyle"] as? String == "kind" && (json["entityLinkColors"] as? [String: String]) == ["element": element],
            "settings.json lacks the link style")
        let cold = LabSettingsStore(directory: harness.root).settings
        try require(cold.entityLinkStyle == .kind && cold.linkStyle.color(for: .element) == element, "A cold store read another link style")
        pane.resetLinkColors()
        try require(store.settings.entityLinkColors.isEmpty && polishHex(attribute(.foregroundColor, kaiAt)) == "#8B72C6",
            "恢复默认颜色 did not return the default")

        // 仅悬停时显示: prose at rest, the whole link in its colour under the pointer.
        polishPick(pane.linkStyleControl, 2)
        func atRest(_ index: Int) -> Bool {
            attribute(.foregroundColor, index) as? NSColor == .labelColor && underline(index) == nil
        }
        try require(atRest(kaiAt) && atRest(kaiAt + 1) && atRest(homeAt) && atRest(tideAt) && view.hoverHighlightRange == nil,
            "仅悬停时显示 does not read as prose at rest")
        view.textView.onHover?(kaiAt + 1)
        try require(view.hoverHighlightRange == NSRange(location: kaiAt, length: 2) && polishHex(attribute(.foregroundColor, kaiAt)) == category
            && polishHex(attribute(.foregroundColor, kaiAt + 1)) == category && underline(kaiAt) == single && atRest(homeAt),
            "Resting on a link did not show it: \(String(describing: view.hoverHighlightRange))")
        view.textView.onHover?(homeAt)
        try require(view.hoverHighlightRange == NSRange(location: homeAt, length: 2) && atRest(kaiAt)
            && attribute(.foregroundColor, homeAt) as? NSColor == .systemBlue, "Moving to another link did not move the colour")
        view.textView.onHover?(nil)
        try require(view.hoverHighlightRange == nil && atRest(homeAt) && atRest(kaiAt), "Leaving the link did not restore the prose")
        view.closeLinkPreview()

        // 不着色: the prose colour with a grey underline.
        polishPick(pane.linkStyleControl, 3)
        try require(attribute(.foregroundColor, kaiAt) as? NSColor == .labelColor && underline(kaiAt) == single
            && attribute(.underlineColor, kaiAt) as? NSColor == .tertiaryLabelColor
            && attribute(.foregroundColor, 0, in: hidden) as? NSColor == .labelColor, "不着色 differs")
        // Styles are presentation only.
        try require(view.textView.string == text && view.textView.selectedRange() == selection
            && view.binding.store.projection?.revision == revision && view.binding.store.projection?.canUndo == canUndo,
            "A link style changed the text, selection, revision or history")
        try harness.journal.expect([], since: mark, "Link styles")
        json = try harness.settingsJSON()
        try require(json["entityLinkStyle"] as? String == "prose" && LabSettingsStore(directory: harness.root).settings.entityLinkStyle == .prose,
            "settings.json lacks 不着色")

        // Typing while a link shows its colour puts the prose back first.
        polishPick(pane.linkStyleControl, 2)
        view.textView.onHover?(kaiAt)
        try require(view.hoverHighlightRange != nil, "The link was not shown before typing")
        try harness.type(view, "风起。")
        try require(view.hoverHighlightRange == nil && atRest(kaiAt) && atRest(kaiAt + 1), "Typing left the link coloured")
        view.closeLinkPreview()

        // The 历史版本 preview: closing captures a version; its links follow.
        polishPick(pane.linkStyleControl, 0)
        let closed: Bool = try elementResult {
            harness.host.closeTab(pane: 0, scope: .chapter(ChapterScope(projectID: project.id, chapterID: rain.id)), completion: $0)
        }
        try require(closed, "雨夜 did not close")
        let target = VersionHistoryTarget(projectID: project.id, kind: "chapter", id: rain.id, title: rain.title)
        let model = VersionHistoryModel(workspace: workspace, target: target)
        let sheet = VersionHistorySheet(model: model)
        sheet.linkDirectory = harness.host.linkDirectory(projectID: project.id)
        sheet.begin(in: nil)
        model.load()
        try wait { model.loaded && !model.busy }
        guard let version = model.entries.first(where: { $0.text.contains("林凯走上码头") }) else {
            throw LabError.message("No version of 雨夜: \(model.entries.map(\.text))")
        }
        sheet.select(entryID: version.id)
        try wait { model.preview(of: version) != nil && model.currentText != nil }
        sheet.reload()
        func preview(_ key: NSAttributedString.Key) -> Any? {
            guard let storage = sheet.previewView.textStorage else { return nil }
            let at = (storage.string as NSString).range(of: "林凯").location
            return at == NSNotFound ? nil : storage.attribute(key, at: at, effectiveRange: nil)
        }
        try require(polishHex(preview(.foregroundColor)) == category, "The 历史版本 preview does not draw 按分类着色: \(polishHex(preview(.foregroundColor)) ?? "none")")
        polishPick(pane.linkStyleControl, 1)
        try require(polishHex(preview(.foregroundColor)) == "#8B72C6", "The 历史版本 preview did not follow 按类型着色")
        polishPick(pane.linkStyleControl, 3)
        try require(preview(.foregroundColor) as? NSColor == .labelColor && preview(.underlineColor) as? NSColor == .tertiaryLabelColor,
            "The 历史版本 preview did not follow 不着色")
        sheet.close()
        polishPick(pane.linkStyleControl, 0)

        // The 全书长卷: an editor and a read-only row set from its projection.
        MacWholeBookViewController.maximumAttached = 1
        defer { MacWholeBookViewController.maximumAttached = 6 }
        let (book, bookWindow) = try harness.book(project)
        defer { bookWindow.close() }
        // Clicking the other row's text gives it an editor; once it no longer
        // has the keyboard it leaves again and shows its text as last styled.
        let rows = [rain.id, homecoming.id].compactMap { book.chapterRow($0) }
        guard rows.count == 2, let detached = rows.first(where: { !$0.isAttached }) else { throw LabError.message("The book did not show both rows") }
        detached.preview.onClick?(0)
        try wait { detached.isAttached && book.isSettled }
        bookWindow.makeFirstResponder(nil)
        // A layout pass places the editors again (a short book does not scroll).
        book.view.needsLayout = true
        book.view.layoutSubtreeIfNeeded()
        do {
            try wait { book.isSettled && rows.contains { !$0.isAttached && $0.shown == .preview } && rows.contains { $0.isAttached } }
        } catch {
            throw LabError.message("No row was released: \(rows.map { "\($0.chapter.title) attached \($0.isAttached) shown \($0.shown)" })")
        }
        guard let released = rows.first(where: { !$0.isAttached }), let attached = rows.first(where: { $0.isAttached })?.editor else {
            throw LabError.message("No row was released")
        }
        func rowColor() -> String? {
            guard let storage = released.preview.textView.textStorage else { return nil }
            let at = (storage.string as NSString).range(of: "林凯").location
            return at == NSNotFound ? nil : polishHex(storage.attribute(.foregroundColor, at: at, effectiveRange: nil))
        }
        let editorAt = (attached.textView.string as NSString).range(of: "林凯").location
        try require(rowColor() == category && editorAt != NSNotFound, "The read-only row is not styled from its projection: \(rowColor() ?? "none")")
        polishPick(pane.linkStyleControl, 1)
        try require(rowColor() == "#8B72C6" && polishHex(attached.textView.textStorage?.attribute(.foregroundColor, at: editorAt, effectiveRange: nil)) == "#8B72C6",
            "The 全书长卷 did not follow 按类型着色: \(rowColor() ?? "none")")
        try require(book.shutdown(), "The 全书长卷 did not shut down")
        try wait { book.isShutDown }
        try harness.close()
    }

    // MARK: (c) Chapter hover previews

    /// A list of the project's chapters, as AppDelegate's chapter list shows them.
    private final class PolishChapterList: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        var chapters: [WorkspaceChapter] = []
        var showingTrash = false
        func numberOfRows(in tableView: NSTableView) -> Int { chapters.count }
        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            NSTextField(labelWithString: chapters[row].title)
        }
    }

    private static func polishHoverPreviews() throws {
        let harness = try PolishHarness()
        defer { harness.remove() }
        let workspace = harness.workspace
        let project = try harness.project("悬停预览合成项目")
        let home = try harness.chapter(project, "归航", ["船回到了港口，灯一盏盏亮起。"])
        let start = try harness.chapter(project, "启程")
        let _: WorkspaceNodeMetadata = try elementResult { workspace.setNodeStatus(projectID: project.id, nodeID: home.id, status: "finished", completion: $0) }
        let _: WorkspaceNodeMetadata = try elementResult { workspace.setNodeSummary(projectID: project.id, nodeID: home.id, summary: "归来的船", completion: $0) }
        harness.host.chaptersChanged(projectID: project.id)
        let counts = harness.host.wordCounts(projectID: project.id, refresh: true)
        try wait { counts.loaded && counts.isIdle }
        guard let words = counts.library?.count(nodeID: home.id), words > 0 else { throw LabError.message("归航 has no word count") }
        var mark = try harness.journal.mark()

        // The chapter list, wired as AppDelegate wires it.
        let list = PolishChapterList()
        list.chapters = [home, start]
        let table = NSTableView()
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name")))
        table.dataSource = list; table.delegate = list
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 230, height: 300))
        scroll.documentView = table
        let listWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 230, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        listWindow.isReleasedWhenClosed = false
        defer { listWindow.close() }
        listWindow.contentView = scroll
        table.reloadData()
        let preview = TableHoverPreview(table: table)
        preview.target = { row in
            guard !list.showingTrash, list.chapters.indices.contains(row) else { return nil }
            return EntityLinkTarget(kind: .chapter, id: list.chapters[row].id, name: list.chapters[row].title)
        }
        preview.source = { target, done in harness.host.hoverCard(for: target, projectID: project.id, completion: done) }
        let hovered = Date()
        preview.hover(row: 0)
        try require(preview.content == nil && preview.isPending, "The card opened without the delay")
        try wait { preview.content != nil }
        try require(Date().timeIntervalSince(hovered) >= TableHoverPreview.delay - 0.01, "The card ignored its delay")
        guard let card = preview.content, let controller = preview.controller else { throw LabError.message("No card for 归航") }
        _ = controller.view
        try require(card.title == "归航" && card.meta == ["章节", WritingStatus.label("finished"), WordCountText.full(words)]
            && card.summary == "归来的船" && !controller.showsOpenHint && !controller.labels.contains { $0.stringValue == "点击打开" }
            && controller.labels.contains { $0.stringValue == "归来的船" }, "The list card reads \(card.lines)")
        // Another row replaces it; an empty 摘要 reads 暂无摘要.
        preview.hover(row: 1)
        try require(preview.content == nil, "The previous card stayed on another row")
        try wait { preview.content != nil }
        try require(preview.content?.title == "启程" && preview.content?.lines.last == "暂无摘要"
            && preview.content?.meta.first == "章节", "The second card reads \(preview.content?.lines ?? [])")
        preview.hover(row: nil)
        try require(preview.content == nil && !preview.isPending, "Leaving the list kept the card")
        // The trash list has no previews.
        list.showingTrash = true
        preview.hover(row: 0)
        try require(!preview.isPending && preview.content == nil, "A trashed row asked for a card")
        list.showingTrash = false
        try harness.journal.expect([], since: mark, "List hover previews")

        // The 整书大纲: chapter rows have the same card; an act row none.
        let outline = WorkspaceOutlineModel(workspace: workspace, projectID: project.id)
        let outlineController = BookOutlineViewController(model: outline)
        outlineController.hoverCardSource = { target, done in harness.host.hoverCard(for: target, projectID: project.id, completion: done) }
        let outlineWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 570), styleMask: [.titled], backing: .buffered, defer: false)
        outlineWindow.isReleasedWhenClosed = false
        defer { outlineWindow.close() }
        outlineWindow.contentViewController = outlineController
        outline.load()
        try wait { !outline.busy && outline.rows.contains { $0.isChapter } }
        outline.createAct(beforeChapterID: start.id)
        try wait { !outline.busy && outline.rows.contains { $0.isAct } }
        mark = try harness.journal.mark()
        guard let outlinePreview = outlineController.hoverPreview,
              let homeRow = outline.rows.firstIndex(where: { $0.isChapter && $0.entry.id == home.id }),
              let actRow = outline.rows.firstIndex(where: { $0.isAct }) else { throw LabError.message("The outline has no rows to hover") }
        outlinePreview.hover(row: homeRow)
        try wait { outlinePreview.content != nil }
        try require(outlinePreview.content?.title == "归航" && outlinePreview.content?.summary == "归来的船"
            && outlinePreview.content?.meta == ["章节", WritingStatus.label("finished"), WordCountText.full(words)],
            "The outline card reads \(outlinePreview.content?.lines ?? [])")
        outlinePreview.hover(row: actRow)
        try require(outlinePreview.content == nil && !outlinePreview.isPending, "An act row asked for a card")
        try harness.journal.expect([], since: mark, "Outline hover previews")
        try harness.close()
    }

    // MARK: (d) The status line's 主线

    private static func polishStatusLine() throws {
        let harness = try PolishHarness()
        defer { harness.remove() }
        let workspace = harness.workspace
        let project = try harness.project("主线字数合成项目")
        let first = try harness.chapter(project, "第一章", ["北境的雪。"])
        let second = try harness.chapter(project, "第二章", ["南岸的风吹过。"])
        let third = try harness.chapter(project, "第三章", ["桥。"])
        func storyline(_ name: String) throws -> WorkspaceStoryline {
            let reply: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
                workspace.createStoryline(projectID: project.id, name: name, completion: $0)
            }
            harness.host.applyStorylineLibrary(projectID: project.id, library: reply.library)
            return reply.result!
        }
        func join(_ chapter: WorkspaceChapter, _ storylines: [WorkspaceStoryline], primary: WorkspaceStoryline?) throws {
            let reply: WorkspaceStorylineReply<WorkspaceChapterStorylines> = try elementResult {
                workspace.setChapterStorylines(projectID: project.id, chapterID: chapter.id, storylineIDs: storylines.map(\.id),
                                               primary: primary?.id, completion: $0)
            }
            harness.host.applyStorylineLibrary(projectID: project.id, library: reply.library)
        }
        let north = try storyline("北境")
        let south = try storyline("南岸")
        try join(first, [north], primary: north)
        try join(second, [north, south], primary: south)
        try join(third, [south], primary: south)
        harness.host.chaptersChanged(projectID: project.id)
        let model = harness.host.wordCounts(projectID: project.id, refresh: true)
        try wait { model.loaded && model.isIdle }
        func count(_ chapter: WorkspaceChapter) -> Int { harness.host.wordCountLibrary(projectID: project.id)?.count(nodeID: chapter.id) ?? -1 }
        func grouped(_ value: Int) -> String { WordCountText.grouped(value) }
        func line() -> String { harness.host.wordStatusLine(projectID: project.id) }
        let view = try harness.open(project, first)
        var (a, b, c) = (count(first), count(second), count(third))
        try require(a > 0 && b > 0 && c > 0, "The chapters are not counted")
        try require(line() == "当前 \(grouped(a)) 字 · 主线「北境」\(grouped(a + b)) 字 · 全书 \(grouped(a + b + c)) 字",
            "The status line reads \(line())")
        // Typing in the chapter: its count, the storyline's and the book's follow.
        try harness.type(view, "风停了。")
        try wait { count(first) > a && model.isIdle }
        a = count(first)
        try require(line() == "当前 \(grouped(a)) 字 · 主线「北境」\(grouped(a + b)) 字 · 全书 \(grouped(a + b + c)) 字",
            "The status line did not follow typing: \(line())")
        // Another chapter shows its own 主线.
        let secondView = try harness.open(project, second)
        try require(line() == "当前 \(grouped(b)) 字 · 主线「南岸」\(grouped(b + c)) 字 · 全书 \(grouped(a + b + c)) 字",
            "The second chapter's line reads \(line())")
        try harness.type(secondView, "潮声。")
        try wait { count(second) > b && model.isIdle }
        b = count(second)
        try require(line() == "当前 \(grouped(b)) 字 · 主线「南岸」\(grouped(b + c)) 字 · 全书 \(grouped(a + b + c)) 字",
            "The line did not follow typing in the second chapter: \(line())")
        // A membership change and a rename follow at once.
        try join(second, [north], primary: north)
        try require(line() == "当前 \(grouped(b)) 字 · 主线「北境」\(grouped(a + b)) 字 · 全书 \(grouped(a + b + c)) 字",
            "The line did not follow a membership change: \(line())")
        let renamed: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            workspace.updateStoryline(projectID: project.id, storylineID: north.id, changes: WorkspaceStorylineChanges(name: "北境线"), completion: $0)
        }
        harness.host.applyStorylineLibrary(projectID: project.id, library: renamed.library)
        try require(line().contains("主线「北境线」\(grouped(a + b)) 字"), "The line did not follow a rename: \(line())")
        // Without storylines only 当前 and 全书 remain.
        try join(second, [], primary: nil)
        try require(line() == "当前 \(grouped(b)) 字 · 全书 \(grouped(a + b + c)) 字", "A chapter without storylines reads \(line())")
        // An uncounted member shows 统计中….
        let partial = WordCountLibrary([WorkspaceNodeWordCount(nodeId: "a", kind: "chapter", wordCount: 5),
                                        WorkspaceNodeWordCount(nodeId: "b", kind: "chapter", wordCount: nil)])
        try require(WordCountText.statusLine(partial, focus: .chapter("a", storyline: "北境", chapterIDs: ["a", "b"]))
            == "当前 5 字 · 主线「北境」统计中… · 全书 统计中…"
            && WordCountText.statusLine(partial, focus: .chapter("a", storyline: "北境", chapterIDs: ["a"])) == "当前 5 字 · 主线「北境」5 字 · 全书 统计中…",
            "The line's wording differs while counting")
        _ = c
        try harness.close()
    }

    // MARK: (e) The 全书长卷's shared controls

    private static func polishWholeBookControls() throws {
        let harness = try PolishHarness()
        defer { harness.remove() }
        let project = try harness.project("长卷工具栏合成项目")
        let chapters = try (1...3).map { number in
            try harness.chapter(project, "长卷第\(number)章", ["第\(number)章开头的一段。", "第\(number)章的第二段。"])
        }
        let (book, bookWindow) = try harness.book(project)
        defer { bookWindow.close() }
        let controls = book.formatControls
        let editors = try chapters.map { chapter -> NativeDocumentView in
            guard let editor = book.chapterRow(chapter.id)?.editor else { throw LabError.message("\(chapter.title) has no editor") }
            return editor
        }
        // No row has its own controls; the shared ones wait for a chapter.
        try require(editors.allSatisfy { $0.controls == nil && polishFind($0, "format-bold") == nil && polishFind($0, "undo-prose") == nil },
            "A row kept its own controls")
        try require(polishFind(book.view, "whole-book-format-bold") === controls.boldButton && book.formatTarget == nil
            && !controls.boldButton.isEnabled && !controls.undoButton.isEnabled && !controls.blockMenu.isEnabled
            && book.editingLabel.stringValue.hasPrefix("点按一章的正文"), "The shared controls are not waiting: \(book.editingLabel.stringValue)")
        func blocks(_ view: NativeDocumentView) -> [NativeBlock] { view.binding.store.projection?.blocks ?? [] }
        func bold(_ view: NativeDocumentView) -> Bool { blocks(view).first?.runs.contains { $0.attributes.bold } == true }
        let untouched = blocks(editors[0])

        // The second chapter takes the keyboard: the controls follow it.
        try require(bookWindow.makeFirstResponder(editors[1].textView), "The second chapter refused the keyboard")
        try require(book.formatTargetChapterID == chapters[1].id && book.formatTarget === editors[1]
            && book.editingLabel.stringValue == "正在编辑：第 2 章 长卷第2章", "The controls did not follow the focus: \(book.editingLabel.stringValue)")
        editors[1].textView.setSelectedRange(NSRange(location: 0, length: 3))
        try require(controls.boldButton.isEnabled && controls.blockMenu.isEnabled && controls.blockMenu.titleOfSelectedItem == "正文",
            "The controls did not follow the selection")
        let mark = try harness.journal.mark()
        controls.boldButton.performClick(nil)
        try harness.settled(editors[1])
        try require(bold(editors[1]) && !bold(editors[0]) && !bold(editors[2]), "加粗 did not act on the focused chapter only")
        controls.blockMenu.selectItem(withTitle: NativeFormatAction.heading2.title)
        controls.blockMenu.sendAction(controls.blockMenu.action, to: controls.blockMenu.target)
        try harness.settled(editors[1])
        try require(blocks(editors[1]).first?.kind == "heading" && blocks(editors[1]).first?.headingLevel == 2
            && blocks(editors[0]).first?.kind == "paragraph" && controls.blockMenu.titleOfSelectedItem == "标题 2",
            "段落样式 did not act on the focused chapter")
        try require(controls.undoButton.isEnabled, "撤销 is off after formatting")
        controls.undoButton.performClick(nil)
        try harness.settled(editors[1])
        try require(blocks(editors[1]).first?.kind == "paragraph" && bold(editors[1]), "撤销 did not undo the heading only")
        let written = try harness.journal.originals(since: mark)
        try require(written.count == 3 && written.allSatisfy { $0 == ["yjs.update prose-document"] }, "The controls wrote \(written)")

        // The first chapter takes the keyboard: 增加缩进 acts there.
        try require(bookWindow.makeFirstResponder(editors[0].textView), "The first chapter refused the keyboard")
        editors[0].textView.setSelectedRange(NSRange(location: 0, length: 0))
        try require(book.formatTargetChapterID == chapters[0].id && book.editingLabel.stringValue == "正在编辑：第 1 章 长卷第1章"
            && controls.indentButton.isEnabled, "The controls did not move to the first chapter")
        controls.indentButton.performClick(nil)
        try harness.settled(editors[0])
        try require(blocks(editors[0]).first?.indent == 1 && blocks(editors[1]).first?.indent == 0 && blocks(editors[2]).first?.indent == 0
            && blocks(editors[0]).map(\.id) == untouched.map(\.id), "增加缩进 did not act on the first chapter")
        // Once that editor leaves the book, the controls turn off.
        try require(book.shutdown(), "The 全书长卷 did not shut down")
        try wait { book.isShutDown }
        try require(book.formatTarget == nil && book.formatTargetChapterID == nil && !controls.boldButton.isEnabled
            && !controls.indentButton.isEnabled && book.editingLabel.stringValue.hasPrefix("点按一章的正文"),
            "The controls stayed on after the editor left")
        try harness.close()
    }

    // MARK: (f) 欢迎使用

    private static func polishWelcome() throws {
        let harness = try PolishHarness()
        defer { harness.remove() }
        let store = harness.settings
        let none: [WorkspaceProject] = []
        try require(MacLaunchChoice.choose(projects: none, last: nil, store: store) == .welcome
            && MacWelcomeSheet.shouldShow(projects: none, store: store), "A lab without projects does not say 欢迎使用")
        let sheet = MacWelcomeSheet(store: store)
        let text = sheet.paragraphs.map(\.stringValue).joined()
        try require(sheet.titleLabel.stringValue == "欢迎使用 Drifting" && text.contains("写长篇小说") && text.contains("这台 Mac")
            && text.contains("无需账号") && text.contains("API Key") && sheet.createButton.title == "新建项目"
            && sheet.importButton.title == "导入…" && sheet.hideCheckbox.title == "不再显示" && sheet.hideCheckbox.state == .off,
            "The sheet does not say what Drifting is: \(text)")
        // Buttons end the sheet first, then run.
        var created = 0, imported = 0, finished = 0
        sheet.onCreate = { created += 1 }
        sheet.onImport = { imported += 1 }
        sheet.onFinish = { finished += 1 }
        sheet.begin(in: nil)
        sheet.create()
        try require(sheet.isFinished && finished == 1 && created == 0, "新建项目 ran before the sheet ended")
        try wait { created == 1 }
        sheet.importFiles()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        try require(imported == 0 && finished == 1, "A finished sheet ran a second button")
        let importing = MacWelcomeSheet(store: store)
        importing.onImport = { imported += 1 }
        importing.importFiles()
        try wait { imported == 1 }
        let later = MacWelcomeSheet(store: store)
        later.onCreate = { created += 1 }; later.onImport = { imported += 1 }
        later.later()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        try require(later.isFinished && created == 1 && imported == 1, "稍后 created or imported")

        // 不再显示 is kept at once; the shelf opens instead.
        let hiding = MacWelcomeSheet(store: store)
        hiding.hideCheckbox.state = .on
        hiding.hideChanged()
        var json = (try JSONSerialization.jsonObject(with: Data(contentsOf: store.fileURL)) as? [String: Any]) ?? [:]
        try require(json["welcomeHidden"] as? Bool == true && store.settings.welcomeHidden
            && MacLaunchChoice.choose(projects: none, last: nil, store: store) == .shelf, "不再显示 was not kept")
        let cold = LabSettingsStore(directory: harness.root)
        try require(cold.settings.welcomeHidden && MacLaunchChoice.choose(projects: none, last: nil, store: cold) == .shelf
            && MacWelcomeSheet(store: cold).hideCheckbox.state == .on, "A cold relaunch forgot 不再显示")
        hiding.hideCheckbox.state = .off
        hiding.hideChanged()
        json = (try JSONSerialization.jsonObject(with: Data(contentsOf: store.fileURL)) as? [String: Any]) ?? [:]
        try require(json["welcomeHidden"] as? Bool == false && MacLaunchChoice.choose(projects: none, last: nil, store: store) == .welcome,
            "Unchecking 不再显示 did not bring the sheet back")

        // With projects: the one selected last, else the shelf; never 欢迎使用.
        let project = try harness.project("欢迎合成项目")
        try require(MacLaunchChoice.choose(projects: [project], last: project, store: store) == .project(project)
            && MacLaunchChoice.choose(projects: [project], last: nil, store: store) == .shelf
            && MacLaunchChoice.choose(projects: [project], last: WorkspaceProject(id: "gone", name: "已删除"), store: store) == .shelf
            && !MacWelcomeSheet.shouldShow(projects: [project], store: store), "A lab with projects offered 欢迎使用")
        try harness.close()
    }
}
