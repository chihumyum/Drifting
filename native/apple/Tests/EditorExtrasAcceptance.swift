import AppKit

/// 设定悬停卡片 and 打字机滚动 through real editors in the tab host, the
/// shared input queue, the Rust workspace and 设置. Hover, clicks and typing
/// are programmatic; every name, body and image is synthetic.
extension BindingAcceptance {
    static func editorExtrasAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay)
        defer { (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay) = saved }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        try hoverCards()
        try typewriterScrolling()
        return [
            "AppKit 设定悬停卡片 opens after the hover delay with an element's name, category and group, aliases, summary, first facts, portrait and counts of valid patches and linking pages, and a chapter's title, status, words and summary; showing it changes no selection, focus, revision or journal, a click opens the page while the editor keeps its selection, and a trashed target's card opens nothing",
            "AppKit 打字机滚动 keeps the caret line at 40% of the visible prose after typing at the end and in the middle of a chapter and in an element page, keeps marked text unpublished and one undo exact, leaves scrolling by hand alone until the next keystroke, stops when switched off and persists in settings.json and 设置",
        ]
    }

    private static func extrasSettled(_ host: MacChapterWorkspace, _ views: NativeDocumentView...) throws {
        try wait {
            !host.isBusy && views.allSatisfy {
                $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks && !$0.binding.store.isLinking
            }
        }
    }

    private static func extrasType(_ host: MacChapterWorkspace, _ view: NativeDocumentView, _ text: String, at location: Int? = nil) throws {
        let at = location ?? (view.textView.string as NSString).length
        view.textView.setSelectedRange(NSRange(location: at, length: 0))
        view.textView.insertText(text, replacementRange: NSRange(location: at, length: 0))
        try extrasSettled(host, view)
    }

    // MARK: 悬停卡片

    private static func hoverCards() throws {
        let (directory, workspace, project, chapter) = try elementFixture()
        let root = directory.deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: root) }
        let journal = JournalProbe(directory: directory)
        let people: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
        }
        let created: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: people.result!.id, name: "林凯", completion: $0)
        }
        let kai = created.result!
        let updated: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.updateElement(projectID: project.id, elementID: kai.id,
                changes: WorkspaceElementChanges(summary: "港口守夜人", groupName: .some("港口"), aliases: ["阿凯", "凯哥"]), completion: $0)
        }
        // Rust keeps aliases in its set order.
        let aliases = "别名：" + updated.result!.aliases.joined(separator: "、")
        try require(Set(updated.result!.aliases) == ["阿凯", "凯哥"], "Aliases were not stored")
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.setElementFacts(projectID: project.id, elementID: kai.id, facts: [
                WorkspaceFact(key: "身份", value: "守夜人"), WorkspaceFact(key: "年龄", value: "三十"),
                WorkspaceFact(key: "住处", value: "灯塔"), WorkspaceFact(key: "爱好", value: "下棋"),
            ], completion: $0)
        }
        let png = root.appendingPathComponent("林凯.png")
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 16, pixelsHigh: 16, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        try rep.representation(using: .png, properties: [:])!.write(to: png)
        let _: WorkspaceMaterialReply<WorkspaceElementPortrait> = try elementResult {
            workspace.setElementPortrait(projectID: project.id, elementID: kai.id, file: try? MaterialSourceFile.inspect(png, imagesOnly: true),
                                         completion: $0)
        }
        let homecoming: WorkspaceChapter = try elementResult { workspace.createChapter(projectID: project.id, title: "归航", completion: $0) }
        let _: WorkspaceNodeMetadata = try elementResult {
            workspace.setNodeStatus(projectID: project.id, nodeID: homecoming.id, status: "finished", completion: $0)
        }
        let _: WorkspaceNodeMetadata = try elementResult {
            workspace.setNodeSummary(projectID: project.id, nodeID: homecoming.id, summary: "归来的船", completion: $0)
        }
        let tide: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: project.id, title: "潮汐", groupID: nil, completion: $0)
        }
        let (window, host) = elementHost(workspace)
        defer { window.close() }
        host.elementsChanged(projectID: project.id)
        // 归航 links 林凯 once opened; it stays in a hidden tab.
        let second: NativeDocumentView = try elementResult { host.open(project: project, chapter: homecoming, completion: $0) }
        try extrasSettled(host, second)
        try wait { host.linkDirectory(projectID: project.id)?.elements[kai.id] != nil }
        try extrasType(host, second, "林凯回来了。")
        try wait { second.linkTargets(at: 0).first?.id == kai.id }
        let view: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try extrasSettled(host, view)
        try extrasType(host, view, "林凯走上码头，提着旧灯，想起归航和潮汐。")
        try wait { view.linkTargets(at: 0).first?.id == kai.id }

        // Two patches anchored in 雨夜; deleting one anchor leaves one valid.
        guard let block = view.binding.store.projection?.blocks.first else { throw LabError.message("雨夜 has no block") }
        let blockText = (view.textView.string as NSString).substring(with: block.range.nsRange)
        for anchor in ["码头", "旧灯"] {
            let _: WorkspacePatchReply<WorkspacePatch> = try elementResult {
                workspace.createPatch(projectID: project.id, elementID: kai.id, title: anchor, body: "变化",
                    source: WorkspacePatchSource(nodeID: chapter.id, blockID: block.id, blockText: blockText, anchorText: anchor), completion: $0)
            }
        }
        let lamp = (view.textView.string as NSString).range(of: "旧灯，")
        view.textView.setSelectedRange(lamp)
        view.textView.insertText("", replacementRange: lamp)
        try extrasSettled(host, view)
        let deadline = Date().addingTimeInterval(5)
        var valid = 2
        while Date() < deadline {
            let patches: [WorkspacePatch] = try elementResult { workspace.elementPatches(projectID: project.id, elementID: kai.id, completion: $0) }
            valid = patches.filter { !$0.isInvalid }.count
            if valid == 1 { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        try require(valid == 1, "Deleting an anchor did not invalidate its patch")

        // Hover: after the delay; the editor keeps focus, selection and revision.
        try require(window.makeFirstResponder(view.textView), "The prose did not take focus")
        let selection = NSRange(location: 2, length: 3)
        view.textView.setSelectedRange(selection)
        try extrasSettled(host, view)
        let revision = view.binding.store.projection!.revision
        let mark = try journal.mark()
        let hovered = Date()
        view.textView.onHover?(0)
        try require(view.previewedLink == nil && view.linkCard == nil, "The card opened without the hover delay")
        try wait { view.linkCard != nil }
        try require(Date().timeIntervalSince(hovered) >= NativeDocumentView.linkPreviewDelay - 0.02, "The card ignored its delay")
        guard let card = view.linkCard, let controller = view.linkCardController else { throw LabError.message("No card") }
        let materials: WorkspaceMaterialLibrary = try elementResult { workspace.materialLibrary(projectID: project.id, completion: $0) }
        let portrait = materials.portrait(elementID: kai.id)?.assetPath
        try require(card.title == "林凯" && card.meta == ["人物", "港口"] && card.aliases == aliases && card.summary == "港口守夜人"
            && card.facts == ["身份：守夜人", "年龄：三十", "住处：灯塔"] && card.counts == "有效补丁 1 · 被 2 个章节和页面引用"
            && card.portraitPath != nil && card.portraitPath == portrait && FileManager.default.fileExists(atPath: card.portraitPath!),
            "The element card reads \(card.lines) portrait \(card.portraitPath ?? "none")")
        let cardView = controller.view
        try wait { controller.portrait.image != nil }
        let shown = controller.labels.map(\.stringValue)
        try require(["林凯", "人物 · 港口", aliases, "港口守夜人", "身份：守夜人", "有效补丁 1 · 被 2 个章节和页面引用", "点击打开"]
            .allSatisfy(shown.contains) && !cardView.acceptsFirstResponder, "The card shows \(shown)")
        try require(view.textView.selectedRange() == selection && window.firstResponder === view.textView
            && view.binding.store.projection!.revision == revision, "Showing the card moved the caret, focus or revision")
        try journal.expect([], since: mark, "Showing a hover card")

        // A click on the card opens the page; the editor keeps its selection.
        guard let click = NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: 0,
                                             windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else {
            throw LabError.message("Could not create a click")
        }
        cardView.mouseDown(with: click)
        try wait { host.activeElement?.id == kai.id && host.canNavigate }
        try require(host.tabTitles(pane: 0) == ["归航", "雨夜", "林凯"] && view.textView.selectedRange() == selection
            && view.linkCard == nil, "The card click did not open the page: \(host.tabTitles(pane: 0))")
        try journal.expect([], since: mark, "Opening a page from its card")

        // A chapter's card: title, status, words and summary.
        let _: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try extrasSettled(host, view)
        let homeAt = (view.textView.string as NSString).range(of: "归航").location
        try wait { view.linkTargets(at: homeAt).first?.id == homecoming.id }
        let counts: WorkspaceWordCounts = try elementResult { workspace.wordCounts(projectID: project.id, completion: $0) }
        guard let words = counts.counts.first(where: { $0.nodeId == homecoming.id })?.wordCount, words > 0 else {
            throw LabError.message("归航 has no word count")
        }
        let chapterMark = try journal.mark()
        try require(view.showLinkPreview(at: homeAt), "No chapter card")
        try wait { view.linkCard != nil }
        let chapterCard = view.linkCard!
        try require(chapterCard.title == "归航" && chapterCard.meta == ["章节", "已完成", WordCountText.full(words)]
            && chapterCard.summary == "归来的船" && chapterCard.counts == nil && chapterCard.portraitPath == nil,
            "The chapter card reads \(chapterCard.lines)")
        try require(view.openPreviewedLink(), "The chapter card did not open")
        try wait { host.activeChapter?.id == homecoming.id && host.canNavigate }
        try journal.expect([], since: chapterMark, "A chapter card")

        // A trashed target's card says so and opens nothing.
        let _: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try extrasSettled(host, view)
        let tideAt = (view.textView.string as NSString).range(of: "潮汐").location
        try wait { view.linkTargets(at: tideAt).first?.id == tide.result!.id }
        let _: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            host.trashDrift(projectID: project.id, driftID: tide.result!.id, completion: $0)
        }
        try wait { view.linkTargets(at: tideAt).first?.trashed == true }
        try require(view.showLinkPreview(at: tideAt) && view.linkCard?.trashed == true && view.linkCard?.meta == ["已在回收站"]
            && view.linkCardController?.onOpen == nil && !view.openPreviewedLink(), "The trashed card is not inert")
        view.closeLinkPreview()
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace did not close")
    }

    // MARK: 打字机滚动

    private static func typewriterScrolling() throws {
        let (directory, workspace, project, _) = try elementFixture()
        let root = directory.deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: root) }
        defer { LabSettingsStore.restoreUnconfigured() }
        let settings = root.appendingPathComponent("settings", isDirectory: true)
        let store = LabSettingsStore(directory: settings)
        store.apply()
        try require(!store.settings.typewriterScrolling && MacEditorPreferences.typewriterScrolling == false, "打字机滚动 is not off by default")
        let blocks = (1...80).map { BookImportBlock.paragraph("第\($0)段：夜色里的港口很安静，灯塔一明一灭。") }
        let imported: WorkspaceImportedEntity = try elementResult {
            workspace.importBlocks(projectID: project.id, title: "长夜", target: .chapter, blocks: blocks, completion: $0)
        }
        guard case .chapter(let long) = imported else { throw LabError.message("The long chapter was not imported") }
        let (window, host) = elementHost(workspace)
        defer { window.close() }
        let view: NativeDocumentView = try elementResult { host.open(project: project, chapter: long, completion: $0) }
        try extrasSettled(host, view)
        window.contentView?.layoutSubtreeIfNeeded()
        guard let scroll = view.textView.enclosingScrollView else { throw LabError.message("The prose does not scroll") }
        try require(view.typewriterTail == 0 && scroll.contentView.bounds.height > 200, "Unexpected prose viewport \(scroll.contentView.bounds)")

        store.update { $0.typewriterScrolling = true }
        try require(MacEditorPreferences.typewriterScrolling == true && view.typewriterTail > scroll.contentView.bounds.height / 2,
            "Turning it on left no room below the text: \(view.typewriterTail)")
        func requireLine(_ context: String) throws {
            try wait { !view.hasScheduledTypewriterAlignment }
            guard let position = view.caretLinePosition else { throw LabError.message("\(context): the caret line was not measured") }
            try require(abs(position - NativeDocumentView.typewriterPosition) < 0.02, "\(context): the caret line sits at \(position)")
        }
        // At the end of the chapter.
        try extrasType(host, view, "尾")
        try requireLine("Typing at the end")
        // In the middle.
        let middle = NSMaxRange((view.textView.string as NSString).range(of: "第40段"))
        try extrasType(host, view, "中", at: middle)
        try requireLine("Typing in the middle")
        try require(view.textView.selectedRange() == NSRange(location: middle + 1, length: 0), "Alignment moved the caret")

        // Marked text stays unpublished; its commit is one undo step.
        let before = try read(host.activeCore!).projection
        let caret = view.textView.selectedRange().location
        view.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: caret, length: 0))
        let composing = try read(host.activeCore!).projection.revision
        try require(view.textView.hasMarkedText() && composing == before.revision, "Marked text was published")
        try requireLine("Composing")
        view.textView.insertText("钟", replacementRange: NSRange(location: NSNotFound, length: 0))
        try extrasSettled(host, view)
        try require(try read(host.activeCore!).projection.text == (before.text as NSString).replacingCharacters(in: NSRange(location: caret, length: 0), with: "钟"),
            "The composition did not commit")
        try requireLine("After committing")
        view.undoProse()
        try extrasSettled(host, view)
        try require(try read(host.activeCore!).projection.text == before.text && view.textView.selectedRange().length == 0,
            "One undo did not restore the text before composing")
        try requireLine("After undo")

        // Scrolling by hand stays until the next keystroke.
        let alignments = view.typewriterAlignments
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        try extrasSettled(host, view)
        try require(scroll.contentView.bounds.origin.y == 0 && view.typewriterAlignments == alignments, "A hand scroll was undone without typing")
        try extrasType(host, view, "再", at: view.textView.selectedRange().location)
        try requireLine("Typing after a hand scroll")

        // An element page follows too.
        let categories: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "地点", completion: $0)
        }
        let element: WorkspaceImportedEntity = try elementResult {
            workspace.importBlocks(projectID: project.id, title: "港口", target: .element(categoryID: categories.result!.id),
                                   blocks: (1...60).map { BookImportBlock.paragraph("港口第\($0)条记录。") }, completion: $0)
        }
        guard case .element(let harbour) = element else { throw LabError.message("The element was not imported") }
        let page: NativeDocumentView = try elementResult { host.open(project: project, element: harbour, completion: $0) }
        try extrasSettled(host, page)
        window.contentView?.layoutSubtreeIfNeeded()
        try extrasType(host, page, "新")
        try wait { !page.hasScheduledTypewriterAlignment }
        guard let pagePosition = page.caretLinePosition else { throw LabError.message("The element page caret was not measured") }
        try require(abs(pagePosition - NativeDocumentView.typewriterPosition) < 0.02, "The element page caret line sits at \(pagePosition)")

        // Off: no room below and no alignment.
        store.update { $0.typewriterScrolling = false }
        let _: NativeDocumentView = try elementResult { host.open(project: project, chapter: long, completion: $0) }
        try extrasSettled(host, view)
        let off = view.typewriterAlignments
        try extrasType(host, view, "停", at: view.textView.selectedRange().location)
        try require(view.typewriterTail == 0 && view.typewriterAlignments == off, "Typewriter scrolling did not stop")

        // settings.json and 设置.
        store.update { $0.typewriterScrolling = true }
        let reread = LabSettingsStore(directory: settings)
        try require(reread.settings.typewriterScrolling, "settings.json lost 打字机滚动")
        let pane = MacEditorSettingsViewController(store: reread)
        _ = pane.view
        try require(pane.typewriterCheckbox.state == .on && pane.typewriterCheckbox.title == "打字机滚动", "设置 does not show 打字机滚动 on")
        pane.typewriterCheckbox.state = .off
        pane.typewriterChanged()
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: reread.fileURL)) as? [String: Any]
        try require(json?["typewriterScrolling"] as? Bool == false && !LabSettingsStore(directory: settings).settings.typewriterScrolling,
            "The checkbox did not save: \(String(describing: json?["typewriterScrolling"]))")
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace did not close")
    }
}
