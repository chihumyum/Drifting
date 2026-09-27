import AppKit

/// Geometry of the 底部时间轴 canvas, in flipped points.
enum BottomTimelineMetrics {
    /// The dock's height below the editor area.
    static let dockHeight: CGFloat = 200
    static let railHeight: CGFloat = 30
    static let laneHeight: CGFloat = 34
    static let tile = NSSize(width: 96, height: 26)
    static let slot: CGFloat = 104
    /// The floating lane-name column.
    static let names: CGFloat = 92
    static let gutter: CGFloat = 12
    /// An empty act's band, so its boundary can still be grabbed.
    static let emptyAct: CGFloat = 30
    static var contentLeft: CGFloat { names + gutter }
    static func slotCenter(_ index: Int) -> CGFloat { contentLeft + CGFloat(index) * slot + slot / 2 }
    /// The x of the boundary before slot `index`.
    static func gapX(_ index: Int) -> CGFloat { contentLeft + CGFloat(index) * slot }
    static var lanesTop: CGFloat { railHeight }
}

/// Which project's 底部时间轴 is shown below the editor. Shown or hidden and
/// the mode are remembered per project in the lab's `settings.json`, never
/// in the journal. Changes made elsewhere reach the shown dock through the
/// `…Changed` calls, which only read.
final class BottomTimelineDock {
    let workspace: LabWorkspaceCore
    let settings: LabSettingsStore
    private(set) var controller: MacBottomTimelineController?
    /// Places the dock's view below the editor, or removes it with nil.
    var onPresent: ((NSView?) -> Void)?
    /// Wires a new dock's callbacks (opening chapters, reporting its changes).
    var configure: ((MacBottomTimelineController, WorkspaceProject) -> Void)?

    init(workspace: LabWorkspaceCore, settings: LabSettingsStore) {
        self.workspace = workspace
        self.settings = settings
    }

    var model: BottomTimelineModel? { controller?.model }
    func isShown(projectID: String) -> Bool { controller?.model.projectID == projectID }

    /// The window now shows this project: its dock appears when it was left
    /// shown, in the remembered mode, and hides otherwise.
    func follow(_ project: WorkspaceProject?) {
        guard let project, let setting = settings.bottomTimeline(projectID: project.id), setting.shown else { close(); return }
        show(project, axis: setting.axis)
    }

    /// 视图 › 底部时间轴.
    func toggle(_ project: WorkspaceProject) {
        if isShown(projectID: project.id) { hide(); return }
        show(project, axis: settings.bottomTimeline(projectID: project.id)?.axis ?? .book)
        remember()
    }

    /// 隐藏, or the menu again: remembered as hidden for the project.
    func hide() {
        guard let model else { return }
        settings.setBottomTimeline(BottomTimelineSetting(shown: false, axis: model.axis), projectID: model.projectID)
        close()
    }

    /// A deleted project's dock goes without remembering anything.
    func forget(projectID: String) {
        if isShown(projectID: projectID) { close() }
    }

    private func show(_ project: WorkspaceProject, axis: StoryGraphModel.Axis) {
        guard !isShown(projectID: project.id) else { return }
        close()
        let model = BottomTimelineModel(workspace: workspace, projectID: project.id)
        model.axis = axis
        let controller = MacBottomTimelineController(model: model)
        controller.onAxisChange = { [weak self] _ in self?.remember() }
        controller.onHide = { [weak self] in self?.hide() }
        configure?(controller, project)
        self.controller = controller
        onPresent?(controller.view)
        model.load()
    }

    private func remember() {
        guard let model else { return }
        settings.setBottomTimeline(BottomTimelineSetting(shown: true, axis: model.axis), projectID: model.projectID)
    }

    private func close() {
        guard controller != nil else { return }
        controller = nil
        onPresent?(nil)
    }

    // MARK: Changes elsewhere

    private func model(_ projectID: String) -> BottomTimelineModel? { model?.projectID == projectID ? model : nil }

    /// Chapters were created, renamed, moved, trashed or restored, or story
    /// time changed elsewhere: chapters, lanes, story time and acts are read again.
    func chaptersChanged(projectID: String) { model(projectID)?.refresh() }
    /// Acts were created, renamed, moved, recoloured or removed elsewhere.
    func actsChanged(projectID: String) { model(projectID)?.actsChanged() }
    func storylinesChanged(projectID: String, library: WorkspaceStorylineLibrary) { model(projectID)?.graph.applyStorylines(library) }
    func driftsChanged(projectID: String, library: WorkspaceDriftLibrary) { model(projectID)?.graph.applyDrifts(library) }
    func nodeMetadataChanged(projectID: String, metadata: WorkspaceNodeMetadata) { model(projectID)?.graph.applyNodeMetadata(metadata) }
    func wordCountsChanged(projectID: String, library: WordCountLibrary) { model(projectID)?.graph.applyWordCounts(library) }
    /// The active tab shows this chapter (nil: no chapter).
    func currentChapterChanged(projectID: String?, chapterID: String?) {
        guard let model else { return }
        model.setCurrentChapter(projectID == model.projectID ? chapterID : nil)
    }
}

/// The 底部时间轴 dock below the editor: 阅读顺序 (chapter tiles in book
/// order in storyline rows, with the 幕 rail) or 故事时间 (tiles by narrative
/// order with the timeline markers, and a 未放置 list). Drags move views only;
/// each drop is one model command, reusing the story graph's.
final class MacBottomTimelineController: NSViewController {
    let model: BottomTimelineModel
    let modeControl = NSSegmentedControl(labels: ["阅读顺序", "故事时间"], trackingMode: .selectOne, target: nil, action: nil)
    let unplacedButton = NSButton(title: "未放置", target: nil, action: nil)
    let locateButton = NSButton(title: "定位当前章", target: nil, action: nil)
    let hideButton = NSButton(title: "隐藏", target: nil, action: nil)
    let statusLabel = NSTextField(labelWithString: "")
    let scrollView = NSScrollView()
    private(set) var canvas: BottomTimelineCanvas!
    /// The 未放置 list, built when it is first shown.
    private(set) var unplacedList: BottomTimelineUnplacedList?
    private var unplacedPopover: NSPopover?
    var onOpenChapter: ((WorkspaceChapter) -> Void)?
    var onHide: (() -> Void)?
    /// The author switched between 阅读顺序 and 故事时间; the choice is remembered.
    var onAxisChange: ((StoryGraphModel.Axis) -> Void)?
    /// Presents a rename prompt or a confirmation. Nil uses a sheet on the
    /// window; acceptance answers here without one.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// The slowest main-thread pass of this dock (renders and scroll
    /// handling), for acceptance.
    private(set) var slowestPass: TimeInterval = 0
    func resetTiming() { slowestPass = 0; canvas.resetTiming() }

    init(model: BottomTimelineModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        view.setAccessibilityIdentifier("bottom-timeline")
        canvas = BottomTimelineCanvas(model: model)
        modeControl.target = self; modeControl.action = #selector(modeChanged)
        modeControl.controlSize = .small
        modeControl.setAccessibilityIdentifier("bottom-timeline-mode")
        modeControl.toolTip = "阅读顺序：按成书顺序排列，上方是幕；故事时间：按故事中发生的先后排列"
        unplacedButton.target = self; unplacedButton.action = #selector(toggleUnplaced)
        unplacedButton.controlSize = .small; unplacedButton.bezelStyle = .rounded
        unplacedButton.setAccessibilityIdentifier("bottom-timeline-unplaced")
        unplacedButton.toolTip = "还没有放进故事时间的章节"
        locateButton.target = self; locateButton.action = #selector(locateCurrent)
        locateButton.controlSize = .small; locateButton.bezelStyle = .rounded
        locateButton.setAccessibilityIdentifier("bottom-timeline-locate")
        hideButton.target = self; hideButton.action = #selector(hide)
        hideButton.controlSize = .small; hideButton.bezelStyle = .rounded
        hideButton.setAccessibilityIdentifier("bottom-timeline-hide")
        hideButton.toolTip = "隐藏底部时间轴（视图 › 底部时间轴）"
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        statusLabel.setAccessibilityIdentifier("bottom-timeline-status")
        let toolbar = NSStackView(views: [modeControl, unplacedButton, locateButton, statusLabel, NSView(), hideButton])
        toolbar.spacing = 8
        toolbar.setHuggingPriority(.defaultHigh, for: .vertical)
        scrollView.hasHorizontalScroller = true; scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .bezelBorder
        scrollView.drawsBackground = false
        scrollView.documentView = canvas
        // Lane names stay at the leading edge while the axis scrolls.
        scrollView.addFloatingSubview(canvas.names, for: .horizontal)
        scrollView.setAccessibilityIdentifier("bottom-timeline-scroll")
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification,
                                               object: scrollView.contentView)
        let stack = NSStackView(views: [toolbar, scrollView])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: view.topAnchor),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            toolbar.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scrollView.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        canvas.onOpenChapter = { [weak self] id in self?.openChapter(id) }
        canvas.onDropChapter = { [weak self] id, lane, placement in self?.model.drop(chapterID: id, lane: lane, placement: placement) }
        canvas.onMoveAct = { [weak self] id, gap in self?.model.moveAct(id: id, toGap: gap) }
        canvas.onRenameAct = { [weak self] id in self?.renameAct(id) }
        canvas.menuProvider = { [weak self] target in self?.menu(for: target) }
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    func reload() {
        guard isViewLoaded else { return }
        statusLabel.stringValue = model.status
        statusLabel.toolTip = model.status
        modeControl.selectedSegment = model.axis == .book ? 0 : 1
        modeControl.isEnabled = model.loaded
        let narrative = model.axis == .narrative
        unplacedButton.isHidden = !narrative
        unplacedButton.title = "未放置 \(model.graph.unplacedChapters.count)"
        locateButton.isEnabled = model.currentChapterID.flatMap { model.graph.chapter(id: $0) } != nil
        canvas.render()
        slowestPass = max(slowestPass, canvas.slowestPass)
        unplacedList?.reload()
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        canvas.fitToVisible()
    }

    @objc private func scrolled() {
        let started = Date()
        // Nothing is read or written while scrolling; the floating names follow.
        slowestPass = max(slowestPass, Date().timeIntervalSince(started))
    }

    @objc private func modeChanged() {
        let axis: StoryGraphModel.Axis = modeControl.selectedSegment == 1 ? .narrative : .book
        guard axis != model.axis else { return }
        if axis == .book { closeUnplaced() }
        model.axis = axis
        onAxisChange?(axis)
    }

    /// Chooses 阅读顺序 or 故事时间 as the control would.
    func setAxis(_ axis: StoryGraphModel.Axis) {
        modeControl.selectedSegment = axis == .book ? 0 : 1
        modeChanged()
    }

    @objc private func hide() { onHide?() }

    /// 定位当前章: scrolls the current chapter's tile into view.
    @objc func locateCurrent() {
        guard let id = model.currentChapterID, let frame = canvas.tileFrames[id] else { return }
        canvas.scrollToVisible(frame.insetBy(dx: -BottomTimelineMetrics.slot, dy: -8))
    }

    private func openChapter(_ id: String) {
        guard let chapter = model.graph.chapter(id: id) else { return }
        onOpenChapter?(chapter)
    }

    // MARK: 未放置

    /// Shows or hides the 未放置 list: a popover under the button while the
    /// window is on screen.
    @objc func toggleUnplaced() {
        if unplacedPopover?.isShown == true { closeUnplaced(); return }
        let list = unplacedList ?? BottomTimelineUnplacedList(model: model)
        unplacedList = list
        list.onOpen = { [weak self] id in self?.closeUnplaced(); self?.openChapter(id) }
        list.onPlace = { [weak self] id in self?.model.placeAtEnd(chapterID: id) }
        list.reload()
        guard view.window?.isVisible == true else { return }
        let popover = NSPopover()
        popover.behavior = .transient
        popover.animates = false
        popover.contentViewController = list
        unplacedPopover = popover
        popover.show(relativeTo: unplacedButton.bounds, of: unplacedButton, preferredEdge: .maxY)
    }

    private func closeUnplaced() {
        unplacedPopover?.performClose(nil)
        unplacedPopover = nil
    }

    // MARK: Menus

    func menu(for target: BottomTimelineCanvas.Target) -> NSMenu? {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in menuItems(for: target) { menu.addItem(item) }
        return menu.items.isEmpty ? nil : menu
    }

    /// A tile's, an act's or the bare rail's items, as the menus show them.
    func menuItems(for target: BottomTimelineCanvas.Target) -> [NSMenuItem] {
        guard model.loaded else { return [] }
        var items: [NSMenuItem] = []
        switch target {
        case .chapter(let id):
            guard model.graph.chapter(id: id) != nil else { return [] }
            items.append(LibraryMenuItem(title: "打开", identifier: "timeline-tile-open") { [weak self] in self?.openChapter(id) })
            if model.axis == .narrative {
                items.append(LibraryMenuItem(title: "移出故事时间", identifier: "timeline-tile-unplace") { [weak self] in
                    self?.model.unplace(chapterID: id)
                })
            } else if let slot = model.graph.bookIndex(of: id), !model.acts.contains(where: { $0.start == slot }) {
                items.append(LibraryMenuItem(title: "在此开始新幕", identifier: "timeline-tile-start-act") { [weak self] in
                    self?.model.createAct(atGap: slot)
                })
            }
            if !model.graph.storylines.storylines.isEmpty {
                let lanes = NSMenuItem(title: "移到轨道", action: nil, keyEquivalent: "")
                lanes.setAccessibilityIdentifier("timeline-tile-lanes")
                let submenu = NSMenu()
                let current = model.graph.primary(of: id)
                for lane in model.graph.lanes {
                    let choice = LibraryMenuItem(title: lane.name, identifier: "timeline-tile-lane-\(lane.identifier)") { [weak self] in
                        self?.model.setLane(chapterID: id, storylineID: lane.storylineID)
                    }
                    choice.state = lane.storylineID == current ? .on : .off
                    if let color = lane.color { choice.image = StorylineChip.dot(hex: color) }
                    submenu.addItem(choice)
                }
                lanes.submenu = submenu
                items.append(lanes)
            }
        case .act(let id, let gap):
            guard let act = model.act(id: id) else { return [] }
            items.append(LibraryMenuItem(title: "重命名…", identifier: "timeline-act-rename") { [weak self] in self?.renameAct(id) })
            if model.chapters.indices.contains(gap), gap != act.start {
                items.append(LibraryMenuItem(title: "在此处开始新幕", identifier: "timeline-act-start-here") { [weak self] in
                    self?.model.createAct(atGap: gap)
                })
            }
            items.append(LibraryMenuItem(title: "删除（章节并入前一幕）", identifier: "timeline-act-delete") { [weak self] in
                self?.confirmRemoveAct(id)
            })
            let color = NSMenuItem(title: "幕颜色", action: nil, keyEquivalent: "")
            color.setAccessibilityIdentifier("timeline-act-color")
            color.submenu = ActColorMenu.make(stored: act.act.color, prefix: "timeline-act-color") { [weak self] hex in
                self?.model.setActColor(id: id, color: hex)
            }
            items.append(color)
        case .rail(let gap):
            guard model.axis == .book, model.chapters.indices.contains(gap) else { return [] }
            items.append(LibraryMenuItem(title: "在此处开始新幕", identifier: "timeline-rail-start-act") { [weak self] in
                self?.model.createAct(atGap: gap)
            })
        }
        for item in items where item is LibraryMenuItem { item.isEnabled = !model.busy }
        return items
    }

    // MARK: Acts

    /// Double-click or 重命名…: the act's name in a prompt.
    func renameAct(_ id: String) {
        guard !model.busy, let act = model.act(id: id) else { return }
        let alert = NSAlert()
        alert.messageText = "重命名幕"
        alert.informativeText = "只更改幕名称，章节和正文保持不变。"
        let field = NSTextField(string: act.act.title)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        field.setAccessibilityIdentifier("timeline-act-name")
        alert.accessoryView = field
        alert.addButton(withTitle: "保存").setAccessibilityIdentifier("confirm-timeline-act-rename")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.model.renameAct(id: id, name: field.stringValue)
        }
        alert.window.makeFirstResponder(field)
    }

    private func confirmRemoveAct(_ id: String) {
        guard let act = model.act(id: id) else { return }
        let alert = NSAlert()
        alert.messageText = "删除“\(act.act.title)”？"
        alert.informativeText = "只删除这一幕的分界：它的章节并入前一幕，章节和正文保持不变。"
        alert.addButton(withTitle: "删除").setAccessibilityIdentifier("confirm-timeline-act-delete")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.model.removeAct(id: id)
        }
    }

    private func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, completion); return }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: completion) }
        else { completion(alert.runModal()) }
    }
}

/// The dock's document view: lane washes, chapter tiles placed by the axis,
/// and the 幕 rail (阅读顺序) or the marker row (故事时间) on top. Tiles, act
/// bands and markers are small views that draw themselves; the canvas takes
/// every click. A render sets frames and state only.
final class BottomTimelineCanvas: NSView {
    enum Target: Equatable {
        case chapter(String)
        /// An act band, with the slot under the pointer.
        case act(String, gap: Int)
        /// The bare 幕 rail before this slot.
        case rail(gap: Int)
    }
    private enum Drag {
        case tile(id: String, start: NSPoint, origin: NSPoint, moved: Bool)
        case act(id: String, start: NSPoint, gap: Int, target: Int, moved: Bool)
    }
    typealias M = BottomTimelineMetrics

    let model: BottomTimelineModel
    let names = BottomTimelineLaneNames()
    /// The insertion point of a tile drag, or the boundary of an act drag.
    let indicator = StoryGraphBand()
    private(set) var lanes: [StoryGraphModel.Lane] = []
    private(set) var laneBands: [StoryGraphBand] = []
    private(set) var tiles: [String: BottomTimelineTileView] = [:]
    private(set) var actViews: [String: BottomTimelineActView] = [:]
    private(set) var markerViews: [String: BottomTimelineMarkerView] = [:]
    /// Each shown chapter's tile frame.
    private(set) var tileFrames: [String: NSRect] = [:]
    /// Tile centres along the current axis, by chapter.
    private(set) var centers: [String: CGFloat] = [:]
    private(set) var axis = NarrativeAxis(placed: [], slot: Double(M.slot), origin: Double(M.slotCenter(0)))
    private var drag: Drag?
    /// A dropped tile keeps its place until the reply lays it out.
    private var pendingDrop: String?
    /// Renders so far, for acceptance: a drag renders nothing.
    private(set) var renders = 0
    private(set) var slowestPass: TimeInterval = 0
    func resetTiming() { slowestPass = 0 }

    var onOpenChapter: ((String) -> Void)?
    var onDropChapter: ((String, String??, StoryGraphModel.Placement?) -> Void)?
    var onMoveAct: ((String, Int) -> Void)?
    var onRenameAct: ((String) -> Void)?
    var menuProvider: ((Target) -> NSMenu?)?

    init(model: BottomTimelineModel) {
        self.model = model
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 160))
        wantsLayer = true
        setAccessibilityIdentifier("bottom-timeline-canvas")
        indicator.tint = .labAccent; indicator.alpha = 0.9
        indicator.isHidden = true
        indicator.setAccessibilityIdentifier("bottom-timeline-indicator")
        addSubview(indicator)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }

    /// A resized dock lays the canvas out again so lanes fill the width.
    func fitToVisible() {
        guard let visible = enclosingScrollView?.contentSize, visible.width > frame.width || visible.height > frame.height else { return }
        render()
    }

    // MARK: Render

    func render() {
        let started = Date()
        defer {
            renders += 1
            slowestPass = max(slowestPass, Date().timeIntervalSince(started))
        }
        let narrative = model.axis == .narrative
        let graph = model.graph
        lanes = graph.lanes
        let axisChapters = graph.axisChapters
        var rank: [String: Int] = [:]
        for (position, chapter) in axisChapters.enumerated() { rank[chapter.id] = position }
        let visible = enclosingScrollView?.contentSize ?? .zero
        let width = max(M.contentLeft + CGFloat(max(axisChapters.count, 1)) * M.slot + M.gutter + M.emptyAct, visible.width)
        let height = max(M.lanesTop + CGFloat(lanes.count) * M.laneHeight + 4, visible.height)
        if frame.size != NSSize(width: width, height: height) { setFrameSize(NSSize(width: width, height: height)) }

        // Lane washes.
        while laneBands.count < lanes.count {
            let band = StoryGraphBand()
            addSubview(band, positioned: .below, relativeTo: nil)
            laneBands.append(band)
        }
        while laneBands.count > lanes.count { laneBands.removeLast().removeFromSuperview() }
        for (position, lane) in lanes.enumerated() {
            let band = laneBands[position]
            band.frame = NSRect(x: 0, y: M.lanesTop + CGFloat(position) * M.laneHeight, width: width, height: M.laneHeight - 2)
            band.tint = lane.color.flatMap(ElementSwatch.color(hex:)) ?? .secondaryLabelColor
            band.alpha = lane.color == nil ? 0.035 : 0.06
            band.setAccessibilityIdentifier("timeline-lane-\(lane.identifier)")
        }

        // Tiles in their lanes at their axis slot.
        var shown = Set<String>(), frames: [String: NSRect] = [:], centers: [String: CGFloat] = [:]
        let current = model.currentChapterID
        for (position, lane) in lanes.enumerated() {
            let top = M.lanesTop + CGFloat(position) * M.laneHeight + (M.laneHeight - 2 - M.tile.height) / 2
            for id in lane.chapterIDs {
                guard let chapter = graph.chapter(id: id), let slot = rank[id] else { continue }
                shown.insert(id)
                let center = M.slotCenter(slot)
                centers[id] = center
                let frame = NSRect(x: center - M.tile.width / 2, y: top, width: M.tile.width, height: M.tile.height)
                frames[id] = frame
                let tile = tiles[id] ?? makeTile(id)
                let number = (graph.bookIndex(of: id) ?? 0) + 1
                let title = chapter.title.isEmpty ? "未命名章节" : chapter.title
                tile.show(number: String(format: "§%02d", number), title: title,
                          tint: lane.color.flatMap(ElementSwatch.color(hex:)), isCurrent: id == current,
                          dimmed: chapter.writingStatus == WritingStatus.discarded.rawValue)
                var tip = "第 \(number) 章 \(title)"
                if let status = chapter.writingStatus, status != WritingStatus.draft.rawValue { tip += " · \(WritingStatus.label(status))" }
                if let words = graph.wordCount(of: id) { tip += " · \(WordCountText.full(words))" }
                tile.toolTip = tip + " · 单击打开，拖动调整位置"
                tile.setAccessibilityLabel("第 \(number) 章 \(title)\(id == current ? "，当前章节" : "")")
                if pendingDrop != id || !model.busy { tile.frame = frame }
            }
        }
        for (id, tile) in tiles where !shown.contains(id) { tile.removeFromSuperview(); tiles[id] = nil }
        tileFrames = frames
        self.centers = centers
        if !model.busy { pendingDrop = nil }

        // The 幕 rail on 阅读顺序.
        var shownActs = Set<String>()
        if !narrative {
            for act in model.acts {
                shownActs.insert(act.id)
                let view = actViews[act.id] ?? makeAct(act.id)
                let left = M.gapX(act.start)
                let right = act.end > act.start ? M.gapX(act.end) : left + M.emptyAct
                view.show(name: act.act.title, detail: "\(act.act.chapterIDs.count) 章",
                          tint: ElementSwatch.color(hex: act.act.hex) ?? .secondaryLabelColor, empty: act.end <= act.start)
                view.toolTip = "\(act.act.title) · \(act.act.chapterIDs.count) 章 · 拖动移动幕的分界，双击重命名，右键查看更多操作"
                view.setAccessibilityLabel("\(act.act.title)，\(act.act.chapterIDs.count) 章")
                view.frame = NSRect(x: left + 1, y: 3, width: max(right - left - 2, 8), height: M.railHeight - 6)
            }
        }
        for (id, view) in actViews where !shownActs.contains(id) { view.removeFromSuperview(); actViews[id] = nil }
        // Empty acts sit above their neighbour's band so they stay grabbable.
        for act in model.acts where act.end <= act.start { if let view = actViews[act.id] { addSubview(view, positioned: .above, relativeTo: nil) } }

        // Timeline markers on 故事时间, through the placed chapters' slots.
        let placed: [(order: Double, x: Double)] = narrative ? graph.placedChapters.compactMap { chapter in
            guard let order = graph.narrativeOrder(of: chapter.id), let x = centers[chapter.id] else { return nil }
            return (order, Double(x))
        } : []
        axis = NarrativeAxis(placed: placed, slot: Double(M.slot), origin: Double(M.slotCenter(0)))
        var shownMarkers = Set<String>()
        if narrative {
            for marker in graph.markers {
                shownMarkers.insert(marker.id)
                let view = markerViews[marker.id] ?? makeMarker(marker.id)
                let caption = graph.caption(of: marker)
                view.show(caption: caption, bound: marker.driftNodeId != nil)
                view.toolTip = marker.driftNodeId == nil ? caption : "\(caption) · 已绑定漂流"
                view.setAccessibilityLabel("时间标记 \(caption)")
                let size = view.fittingWidth
                let x = min(max(CGFloat(axis.x(order: marker.narrativeOrder)), M.contentLeft + size / 2), width - size / 2 - 4)
                view.frame = NSRect(x: x - size / 2, y: 5, width: size, height: M.railHeight - 10)
            }
        }
        for (id, view) in markerViews where !shownMarkers.contains(id) { view.removeFromSuperview(); markerViews[id] = nil }

        addSubview(indicator, positioned: .above, relativeTo: nil)
        names.show(lanes: lanes, rail: narrative ? "时间" : "幕", height: height)
    }

    private func makeTile(_ id: String) -> BottomTimelineTileView {
        let view = BottomTimelineTileView()
        view.setAccessibilityIdentifier("timeline-tile-\(id)")
        addSubview(view)
        tiles[id] = view
        return view
    }

    private func makeAct(_ id: String) -> BottomTimelineActView {
        let view = BottomTimelineActView()
        view.setAccessibilityIdentifier("timeline-act-\(id)")
        addSubview(view)
        actViews[id] = view
        return view
    }

    private func makeMarker(_ id: String) -> BottomTimelineMarkerView {
        let view = BottomTimelineMarkerView()
        view.setAccessibilityIdentifier("timeline-marker-\(id)")
        addSubview(view)
        markerViews[id] = view
        return view
    }

    // MARK: Geometry

    /// The act band under a point on the rail; an empty act wins over the
    /// band it sits on.
    func actID(at point: NSPoint) -> String? {
        guard model.axis == .book, point.y < M.railHeight else { return nil }
        let hits = model.acts.filter { actViews[$0.id]?.frame.insetBy(dx: -2, dy: -3).contains(point) == true }
        return (hits.first { $0.end <= $0.start } ?? hits.last)?.id
    }

    /// The chapter slot a point falls in along the axis.
    func slot(at x: CGFloat) -> Int { Int(floor((x - M.contentLeft) / M.slot)) }

    /// The boundary slot nearest a point.
    func gap(at x: CGFloat) -> Int { Int(((x - M.contentLeft) / M.slot).rounded()) }

    func tileID(at point: NSPoint) -> String? {
        guard point.y >= M.lanesTop else { return nil }
        return tileFrames.first { $0.value.contains(point) }?.key
    }

    /// The lane (nil: unchanged) and placement (nil: unchanged) of a tile
    /// whose centre is at `center`: the story graph's rules through its model.
    func chapterDrop(_ id: String, center: NSPoint) -> (lane: String??, placement: StoryGraphModel.Placement?) {
        let graph = model.graph
        guard center.y >= M.lanesTop - M.laneHeight / 2, !lanes.isEmpty else { return (nil, nil) }
        let laneIndex = min(max(Int(floor((center.y - M.lanesTop) / M.laneHeight)), 0), lanes.count - 1)
        let target = lanes[laneIndex].storylineID
        let lane: String?? = graph.storylines.storylines.isEmpty || target == graph.primary(of: id) ? nil : .some(target)
        let others = graph.axisChapters.filter { $0.id != id }
        let count = others.filter { (centers[$0.id] ?? .greatestFiniteMagnitude) < center.x }.count
        let placement: StoryGraphModel.Placement?
        if model.axis == .narrative {
            placement = graph.narrativeOrder(moving: id, toIndex: count).map { .narrative($0) }
        } else {
            placement = graph.bookDestination(moving: id, toIndex: count).map { .book(before: $0) }
        }
        return (lane, placement)
    }

    // MARK: Mouse

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        drag = nil
        if let id = actID(at: point) {
            if event.clickCount >= 2 { onRenameAct?(id); return }
            guard !model.busy, model.loaded, let act = model.act(id: id) else { return }
            drag = .act(id: id, start: point, gap: act.start, target: act.start, moved: false)
            return
        }
        guard let id = tileID(at: point), let tile = tiles[id] else { return }
        guard !model.busy, model.loaded else { return }
        drag = .tile(id: id, start: point, origin: tile.frame.origin, moved: false)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let drag else { return }
        let point = convert(event.locationInWindow, from: nil)
        switch drag {
        case .tile(let id, let start, let origin, var moved):
            let dx = point.x - start.x, dy = point.y - start.y
            if !moved {
                guard hypot(dx, dy) >= 3 else { return }
                moved = true
                tiles[id]?.isLifted = true
                tiles[id]?.layer?.zPosition = 10
            }
            self.drag = .tile(id: id, start: start, origin: origin, moved: moved)
            guard let tile = tiles[id] else { return }
            tile.setFrameOrigin(NSPoint(x: max(M.contentLeft - M.tile.width / 2, origin.x + dx), y: max(0, origin.y + dy)))
            showTileIndicator(id, center: NSPoint(x: tile.frame.midX, y: tile.frame.midY))
        case .act(let id, let start, let gap, _, var moved):
            let dx = point.x - start.x
            if !moved {
                guard abs(dx) >= 3 else { return }
                moved = true
            }
            // Clamped strictly between the neighbouring boundaries; the act's
            // own start stays reachable (a drop there writes nothing).
            let range = model.dragRange(actID: id) ?? gap...gap
            let target = min(max(self.gap(at: M.gapX(gap) + dx), range.lowerBound), range.upperBound)
            self.drag = .act(id: id, start: start, gap: gap, target: target, moved: moved)
            indicator.frame = NSRect(x: M.gapX(target) - 1, y: 0, width: 2, height: frame.height)
            indicator.isHidden = false
        }
        autoscroll(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        guard let drag else { return }
        self.drag = nil
        indicator.isHidden = true
        switch drag {
        case .tile(let id, _, _, let moved):
            guard let tile = tiles[id] else { return }
            tile.isLifted = false
            tile.layer?.zPosition = 0
            guard moved else { onOpenChapter?(id); return }
            pendingDrop = id
            let drop = chapterDrop(id, center: NSPoint(x: tile.frame.midX, y: tile.frame.midY))
            onDropChapter?(id, drop.lane, drop.placement)
            // A drop that sent nothing lays the tile back at once.
            if !model.busy { pendingDrop = nil; render() }
        case .act(let id, _, _, let target, let moved):
            guard moved else { return }
            onMoveAct?(id, target)
        }
    }

    /// Where a dragged tile would land among the others in its lane row.
    private func showTileIndicator(_ id: String, center: NSPoint) {
        guard center.y >= M.lanesTop - M.laneHeight / 2, !lanes.isEmpty else { indicator.isHidden = true; return }
        let laneIndex = min(max(Int(floor((center.y - M.lanesTop) / M.laneHeight)), 0), lanes.count - 1)
        let others = model.graph.axisChapters.filter { $0.id != id }.compactMap { centers[$0.id] }
        let count = others.filter { $0 < center.x }.count
        let x = count < others.count ? others[count] - M.slot / 2 : (others.last.map { $0 + M.slot / 2 } ?? M.contentLeft)
        indicator.frame = NSRect(x: x - 1, y: M.lanesTop + CGFloat(laneIndex) * M.laneHeight + 3, width: 2, height: M.laneHeight - 8)
        indicator.isHidden = false
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        guard let target = target(at: point) else { return nil }
        return menuProvider?(target)
    }

    /// What a right-click at a point would act on.
    func target(at point: NSPoint) -> Target? {
        if let id = actID(at: point) { return .act(id, gap: max(0, slot(at: point.x))) }
        if point.y < M.railHeight { return model.axis == .book ? .rail(gap: max(0, slot(at: point.x))) : nil }
        return tileID(at: point).map { .chapter($0) }
    }
}

/// A chapter tile: its § number and title on a wash of its lane's colour; the
/// current chapter is outlined in the accent colour.
final class BottomTimelineTileView: NSView {
    private(set) var number = ""
    private(set) var title = ""
    private(set) var tint: NSColor?
    private(set) var isCurrent = false
    var isLifted = false { didSet { if isLifted != oldValue { needsDisplay = true } } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var isFlipped: Bool { true }

    func show(number: String, title: String, tint: NSColor?, isCurrent: Bool, dimmed: Bool) {
        guard number != self.number || title != self.title || tint != self.tint || isCurrent != self.isCurrent else {
            alphaValue = dimmed ? 0.5 : 1; return
        }
        self.number = number; self.title = title; self.tint = tint; self.isCurrent = isCurrent
        alphaValue = dimmed ? 0.5 : 1
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75), xRadius: 6, yRadius: 6)
        let base = tint ?? .secondaryLabelColor
        base.withAlphaComponent(isLifted ? 0.32 : isCurrent ? 0.26 : (tint == nil ? 0.1 : 0.17)).setFill()
        shape.fill()
        if isCurrent {
            NSColor.labAccent.setStroke()
            shape.lineWidth = 1.5
            shape.stroke()
        }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let text = NSMutableAttributedString(string: number + " ", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor,
            .paragraphStyle: paragraph])
        text.append(NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 11.5, weight: isCurrent ? .semibold : .regular), .foregroundColor: NSColor.labelColor,
            .paragraphStyle: paragraph]))
        text.draw(with: NSRect(x: 7, y: 6, width: bounds.width - 12, height: bounds.height - 8),
                  options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    /// The canvas takes every click.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// An act on the rail: its name and chapter count on a wash of its colour
/// (stored with 幕颜色, else the hue by position). No edge accent.
final class BottomTimelineActView: NSView {
    private(set) var name = ""
    private(set) var detail = ""
    private(set) var tint: NSColor = .secondaryLabelColor
    private(set) var empty = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var isFlipped: Bool { true }

    func show(name: String, detail: String, tint: NSColor, empty: Bool) {
        guard name != self.name || detail != self.detail || tint != self.tint || empty != self.empty else { return }
        self.name = name; self.detail = detail; self.tint = tint; self.empty = empty
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        tint.withAlphaComponent(empty ? 0.35 : 0.24).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let text = NSMutableAttributedString(string: name, attributes: [
            .font: NSFont.systemFont(ofSize: 11.5, weight: .semibold), .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph])
        if !empty {
            text.append(NSAttributedString(string: "  " + detail, attributes: [
                .font: NSFont.systemFont(ofSize: 10.5), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: paragraph]))
        }
        text.draw(with: NSRect(x: 8, y: 5, width: max(bounds.width - 12, 0), height: bounds.height - 6),
                  options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }
}

/// A timeline marker on 故事时间: a small pill with its caption.
final class BottomTimelineMarkerView: NSView {
    private(set) var caption = ""
    private(set) var bound = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var isFlipped: Bool { true }

    private var attributes: [NSAttributedString.Key: Any] {
        [.font: NSFont.systemFont(ofSize: 10.5, weight: .medium), .foregroundColor: bound ? NSColor.labelColor : NSColor.secondaryLabelColor]
    }

    var fittingWidth: CGFloat { min(150, max(36, ceil((caption as NSString).size(withAttributes: attributes).width) + 18)) }

    func show(caption: String, bound: Bool) {
        guard caption != self.caption || bound != self.bound else { return }
        self.caption = caption; self.bound = bound
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        (bound ? NSColor.labAccent.withAlphaComponent(0.18) : NSColor.secondaryLabelColor.withAlphaComponent(0.12)).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        paragraph.alignment = .center
        var attributes = self.attributes
        attributes[.paragraphStyle] = paragraph
        (caption as NSString).draw(with: NSRect(x: 6, y: 3, width: bounds.width - 12, height: bounds.height - 4),
                                   options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes)
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Lane names at the leading edge: the rail's label (幕 or 时间), then a
/// colour dot and name per lane. It floats over the canvas.
final class BottomTimelineLaneNames: NSView {
    private var labels: [NSView] = []
    private(set) var titles: [String] = []

    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }

    func show(lanes: [StoryGraphModel.Lane], rail: String, height: CGFloat) {
        frame = NSRect(x: 0, y: 0, width: BottomTimelineMetrics.names, height: height)
        let next = [rail] + lanes.map(\.name)
        let colors = lanes.map(\.color)
        guard next != titles || labels.isEmpty || colorsShown != colors else { return }
        titles = next; colorsShown = colors
        labels.forEach { $0.removeFromSuperview() }
        labels = []
        let railLabel = NSTextField(labelWithString: rail)
        railLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        railLabel.textColor = .secondaryLabelColor
        railLabel.frame = NSRect(x: 10, y: 8, width: BottomTimelineMetrics.names - 14, height: 15)
        addSubview(railLabel); labels.append(railLabel)
        for (index, lane) in lanes.enumerated() {
            let top = BottomTimelineMetrics.lanesTop + CGFloat(index) * BottomTimelineMetrics.laneHeight
            let dot = NSImageView(image: lane.color.map(StorylineChip.dot(hex:)) ?? StorylineChip.hollowDot())
            dot.frame = NSRect(x: 10, y: top + 11, width: 10, height: 10)
            let name = NSTextField(labelWithString: lane.name)
            name.font = .systemFont(ofSize: 11.5, weight: .medium)
            name.lineBreakMode = .byTruncatingTail
            name.frame = NSRect(x: 25, y: top + 8, width: BottomTimelineMetrics.names - 29, height: 16)
            name.toolTip = "\(lane.name) · \(lane.chapterIDs.count) 章"
            for view in [dot, name] as [NSView] { addSubview(view); labels.append(view) }
        }
    }
    private var colorsShown: [String?] = []
}

/// 未放置: the chapters without a story time, in book order. A title opens
/// the chapter; 放到末尾 places it after the last placed chapter.
final class BottomTimelineUnplacedList: NSViewController {
    let model: BottomTimelineModel
    private let stack = NSStackView()
    /// One row per listed chapter, in book order.
    private(set) var rows: [(chapterID: String, open: NSButton, place: NSButton)] = []
    var onOpen: ((String) -> Void)?
    var onPlace: ((String) -> Void)?

    init(model: BottomTimelineModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        stack.setAccessibilityIdentifier("bottom-timeline-unplaced-list")
        view = stack
    }

    func reload() {
        _ = view
        for row in stack.arrangedSubviews { stack.removeArrangedSubview(row); row.removeFromSuperview() }
        rows = []
        let chapters = model.graph.unplacedChapters
        let heading = NSTextField(labelWithString: chapters.isEmpty ? "所有章节都已放进故事时间" : "未放置 · \(chapters.count) 章")
        heading.font = .systemFont(ofSize: 12, weight: .semibold)
        heading.textColor = .secondaryLabelColor
        stack.addArrangedSubview(heading)
        for chapter in chapters.prefix(200) {
            let number = (model.graph.bookIndex(of: chapter.id) ?? 0) + 1
            let open = UnplacedButton(title: String(format: "§%02d ", number) + (chapter.title.isEmpty ? "未命名章节" : chapter.title)) {
                [weak self] in self?.onOpen?(chapter.id)
            }
            open.isBordered = false
            open.alignment = .left
            open.setAccessibilityIdentifier("timeline-unplaced-open-\(chapter.id)")
            open.toolTip = "打开这一章"
            let place = UnplacedButton(title: "放到末尾") { [weak self] in self?.onPlace?(chapter.id) }
            place.controlSize = .small; place.bezelStyle = .rounded
            place.setAccessibilityIdentifier("timeline-unplaced-place-\(chapter.id)")
            place.toolTip = "放到故事时间的末尾"
            place.isEnabled = !model.busy
            let row = NSStackView(views: [open, NSView(), place])
            row.spacing = 8
            row.widthAnchor.constraint(equalToConstant: 260).isActive = true
            stack.addArrangedSubview(row)
            rows.append((chapter.id, open, place))
        }
    }
}

private final class UnplacedButton: NSButton {
    private let pressed: () -> Void
    init(title: String, pressed: @escaping () -> Void) {
        self.pressed = pressed
        super.init(frame: .zero)
        self.title = title
        target = self; action = #selector(press)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func press() { pressed() }
}
