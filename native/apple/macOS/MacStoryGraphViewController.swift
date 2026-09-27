import AppKit

final class StoryGraphPanel: NSPanel {
    var onClose: (() -> Void)?
    /// The panel became key again, e.g. after edits in the main window.
    var onBecomeKey: (() -> Void)?
    override func close() { super.close(); onClose?() }
    override func becomeKey() { super.becomeKey(); onBecomeKey?() }
}

/// Geometry of the story graph canvas, in flipped points.
enum StoryGraphMetrics {
    static let rail: CGFloat = 132
    static let gutter: CGFloat = 16
    static let axisHeight: CGFloat = 44
    static let laneHeight: CGFloat = 84
    static let card = NSSize(width: 136, height: 62)
    static let slot: CGFloat = 150
    static let trayGap: CGFloat = 14
    static let trayHeight: CGFloat = 92
    static let driftGap: CGFloat = 18
    static let driftHeader: CGFloat = 28
    static let driftCard = NSSize(width: 150, height: 52)
    static let driftAreaMinHeight: CGFloat = 180
    static let driftsPerRow = 6
    static let driftMargin: CGFloat = 8
    static var contentLeft: CGFloat { rail + gutter }
    static func slotCenter(_ index: Int) -> CGFloat { contentLeft + CGFloat(index) * slot + slot / 2 }
}

/// The 故事图谱 panel: a toolbar with the axis (成书顺序 or 故事时间) and
/// 添加标记…, and the canvas of storyline lanes, the 未放置 tray, timeline
/// markers and drift cards. Drags move layer-backed views only; each drop is
/// one model command whose reply lays the canvas out again.
final class MacStoryGraphViewController: NSViewController {
    let model: StoryGraphModel
    var onClose: (() -> Void)?
    var onOpenChapter: ((WorkspaceChapter) -> Void)?
    var onOpenDrift: ((WorkspaceDrift) -> Void)?
    /// Writes a chapter's status through the tab host so pages follow; nil
    /// writes through the model.
    var onSetStatus: ((WorkspaceChapter, String) -> Void)?
    /// Presents a confirmation or a text prompt. Nil uses a sheet on the
    /// panel; acceptance answers here without a window.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    let axisControl = NSSegmentedControl(labels: ["成书顺序", "故事时间"], trackingMode: .selectOne, target: nil, action: nil)
    let addMarkerButton = NSButton(title: "添加标记…", target: nil, action: nil)
    let statusLabel = NSTextField(wrappingLabelWithString: "")
    let scrollView = NSScrollView()
    private(set) var canvas: StoryGraphCanvas!
    private var laidOutSize = NSSize.zero

    init(model: StoryGraphModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        canvas = StoryGraphCanvas(model: model)
        axisControl.target = self; axisControl.action = #selector(axisChanged)
        axisControl.selectedSegment = model.axis == .book ? 0 : 1
        axisControl.setAccessibilityIdentifier("graph-axis")
        axisControl.toolTip = "成书顺序：按阅读顺序排列；故事时间：按故事中发生的先后排列（允许倒叙）"
        addMarkerButton.target = self; addMarkerButton.action = #selector(addMarkerAtEnd)
        addMarkerButton.setAccessibilityIdentifier("graph-add-marker")
        addMarkerButton.toolTip = "在故事时间的末尾添加一个时间标记；也可以在标记行右键，在指定位置添加"
        let close = NSButton(title: "关闭", target: self, action: #selector(closeGraph))
        close.setAccessibilityIdentifier("close-story-graph")
        let toolbar = NSStackView(views: [axisControl, addMarkerButton, NSView(), close])
        toolbar.spacing = 10
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.setAccessibilityIdentifier("graph-status")
        scrollView.hasVerticalScroller = true; scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.documentView = canvas
        // Lane names stay at the leading edge while the axis scrolls.
        scrollView.addFloatingSubview(canvas.rail, for: .horizontal)
        scrollView.setAccessibilityIdentifier("graph-scroll")
        let stack = NSStackView(views: [toolbar, statusLabel, scrollView])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -12),
            toolbar.widthAnchor.constraint(equalTo: stack.widthAnchor),
            statusLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scrollView.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        canvas.onDropChapter = { [weak self] id, lane, placement in self?.model.drop(chapterID: id, lane: lane, placement: placement) }
        canvas.onDropMarker = { [weak self] id, order in
            self?.model.updateMarker(id: id, changes: TimelineMarkerChanges(narrativeOrder: order), message: "时间标记的位置已保存。")
        }
        canvas.onDropDrift = { [weak self] id, x, y in self?.model.moveDrift(id: id, x: x, y: y) }
        canvas.onOpenChapter = { [weak self] id in self?.openChapter(id) }
        canvas.onOpenDrift = { [weak self] id in self?.openDrift(id) }
        canvas.onEditMarker = { [weak self] id in self?.renameMarker(id) }
        canvas.menuProvider = { [weak self] target in self?.menu(for: target) }
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }

    func reload() {
        guard isViewLoaded else { return }
        statusLabel.stringValue = model.status
        axisControl.selectedSegment = model.axis == .book ? 0 : 1
        addMarkerButton.isEnabled = model.loaded && !model.busy && model.axis == .narrative
        axisControl.isEnabled = model.loaded
        canvas.render()
    }

    /// A resized panel lays the canvas out again so lanes fill the width.
    override func viewDidLayout() {
        super.viewDidLayout()
        guard scrollView.contentSize != laidOutSize else { return }
        laidOutSize = scrollView.contentSize
        canvas.render()
    }

    @objc private func axisChanged() {
        model.axis = axisControl.selectedSegment == 1 ? .narrative : .book
    }

    @objc private func closeGraph() { onClose?() }

    private func openChapter(_ id: String) {
        guard let chapter = model.chapter(id: id) else { return }
        onOpenChapter?(chapter)
    }

    private func openDrift(_ id: String) {
        guard let drift = model.drifts.drift(id: id) else { return }
        onOpenDrift?(drift)
    }

    // MARK: Menus

    /// A card's, marker's or drift's menu, or the marker row's at an order.
    func menu(for target: StoryGraphCanvas.Target) -> NSMenu? {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in menuItems(for: target) { menu.addItem(item) }
        return menu.items.isEmpty ? nil : menu
    }

    func menuItems(for target: StoryGraphCanvas.Target) -> [NSMenuItem] {
        switch target {
        case .chapter(let id): return chapterItems(id)
        case .marker(let id): return markerItems(id)
        case .drift(let id):
            return [LibraryMenuItem(title: "打开", identifier: "graph-drift-open") { [weak self] in self?.openDrift(id) }]
        case .axis(let order):
            guard model.axis == .narrative, model.loaded else { return [] }
            return [LibraryMenuItem(title: "在此处新建标记…", identifier: "graph-axis-add-marker") { [weak self] in
                self?.promptNewMarker(order: order)
            }]
        }
    }

    private func chapterItems(_ id: String) -> [NSMenuItem] {
        guard let chapter = model.chapter(id: id) else { return [] }
        var items: [NSMenuItem] = [LibraryMenuItem(title: "打开", identifier: "graph-card-open") { [weak self] in self?.openChapter(id) }]
        let placed = model.narrativeOrder(of: id) != nil
        if placed {
            let unplace = LibraryMenuItem(title: "移出故事时间", identifier: "graph-card-unplace") { [weak self] in
                self?.model.unplace(chapterID: id)
            }
            unplace.toolTip = "清除这一章在故事时间中的位置，放回“未放置”"
            items.append(unplace)
        } else {
            items.append(LibraryMenuItem(title: "放到故事时间末尾", identifier: "graph-card-place-end") { [weak self] in
                self?.model.placeAtEnd(chapterID: id)
            })
        }
        if !model.storylines.storylines.isEmpty {
            let lanes = NSMenuItem(title: "移到轨道", action: nil, keyEquivalent: "")
            lanes.setAccessibilityIdentifier("graph-card-lanes")
            let submenu = NSMenu()
            let current = model.primary(of: id)
            for lane in model.lanes {
                let choice = LibraryMenuItem(title: lane.name, identifier: "graph-card-lane-\(lane.identifier)") { [weak self] in
                    self?.model.setLane(chapterID: id, storylineID: lane.storylineID)
                }
                choice.state = lane.storylineID == current ? .on : .off
                if let color = lane.color { choice.image = StorylineChip.dot(hex: color) }
                submenu.addItem(choice)
            }
            lanes.submenu = submenu
            items.append(lanes)
        }
        items.append(.separator())
        let header = NSMenuItem(title: "写作状态", action: nil, keyEquivalent: "")
        header.isEnabled = false
        items.append(header)
        for status in WritingStatus.chapter {
            let choice = LibraryMenuItem(title: status.label, identifier: "graph-card-status-\(status.rawValue)") { [weak self] in
                guard let self, chapter.writingStatus != status.rawValue else { return }
                if let onSetStatus = self.onSetStatus { onSetStatus(chapter, status.rawValue) }
                else { self.model.setStatus(chapterID: id, status: status.rawValue) }
            }
            choice.state = chapter.writingStatus == status.rawValue ? .on : .off
            items.append(choice)
        }
        for item in items where item is LibraryMenuItem { item.isEnabled = !model.busy }
        return items
    }

    private func markerItems(_ id: String) -> [NSMenuItem] {
        guard let marker = model.timeline.marker(id: id) else { return [] }
        var items: [NSMenuItem] = [LibraryMenuItem(title: "重命名…", identifier: "graph-marker-rename") { [weak self] in
            self?.renameMarker(id)
        }]
        let bind = NSMenuItem(title: "绑定漂流", action: nil, keyEquivalent: "")
        bind.setAccessibilityIdentifier("graph-marker-bind")
        let submenu = NSMenu()
        for drift in model.drifts.drifts {
            let choice = LibraryMenuItem(title: drift.title, identifier: "graph-marker-bind-\(drift.id)") { [weak self] in
                self?.model.updateMarker(id: id, changes: TimelineMarkerChanges(driftID: .some(drift.id)),
                                         message: "时间标记已绑定漂流“\(drift.title)”。")
            }
            choice.state = marker.driftNodeId == drift.id ? .on : .off
            submenu.addItem(choice)
        }
        if submenu.items.isEmpty {
            let empty = NSMenuItem(title: "还没有漂流", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            submenu.addItem(empty)
        }
        bind.submenu = submenu
        items.append(bind)
        if let driftID = marker.driftNodeId {
            items.append(LibraryMenuItem(title: "打开漂流", identifier: "graph-marker-open-drift") { [weak self] in
                self?.openDrift(driftID)
            })
            items.append(LibraryMenuItem(title: "解除绑定", identifier: "graph-marker-unbind") { [weak self] in
                guard let self else { return }
                // A label-less marker keeps its drift's title as its label.
                let label = marker.label.isEmpty ? self.model.caption(of: marker) : nil
                self.model.updateMarker(id: id, changes: TimelineMarkerChanges(label: label, driftID: .some(nil)),
                                        message: "时间标记已解除绑定，漂流本身保留。")
            })
        }
        items.append(.separator())
        items.append(LibraryMenuItem(title: "删除标记…", identifier: "graph-marker-delete") { [weak self] in self?.confirmDeleteMarker(id) })
        for item in items where item is LibraryMenuItem { item.isEnabled = !model.busy }
        return items
    }

    // MARK: Markers

    /// 添加标记…: after the last chapter or marker in story time.
    @objc func addMarkerAtEnd() {
        let orders = model.placedChapters.compactMap { model.narrativeOrder(of: $0.id) } + model.markers.map(\.narrativeOrder)
        promptNewMarker(order: StoryGraphModel.order(between: orders.max(), and: nil))
    }

    func promptNewMarker(order: Double) {
        guard !model.busy else { return }
        let alert = NSAlert()
        alert.messageText = "新建时间标记"
        var informative = "时间标记标出故事中的一个时刻，例如“开战前夜”或“1938 春”。"
        if model.conversion == nil { informative += "两个以上带数字的标记会把故事时间换算成具体时间。" }
        alert.informativeText = informative
        let field = NSTextField(string: "")
        field.placeholderString = "标记名称"
        field.setAccessibilityIdentifier("graph-marker-name")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "添加").setAccessibilityIdentifier("confirm-graph-marker")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            self.model.createMarker(order: order, label: field.stringValue)
        }
        alert.window.makeFirstResponder(field)
    }

    func renameMarker(_ id: String) {
        guard !model.busy, let marker = model.timeline.marker(id: id) else { return }
        let alert = NSAlert()
        alert.messageText = "重命名时间标记"
        alert.informativeText = marker.driftNodeId == nil ? "名称不能为空。"
            : "绑定了漂流的标记可以不写名称，这时显示漂流的标题。"
        let field = NSTextField(string: marker.label)
        field.placeholderString = marker.driftNodeId == nil ? "标记名称" : model.caption(of: marker)
        field.setAccessibilityIdentifier("graph-marker-rename-field")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "保存").setAccessibilityIdentifier("confirm-graph-marker-rename")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            self.model.updateMarker(id: id, changes: TimelineMarkerChanges(label: field.stringValue), message: "时间标记名称已保存。")
        }
        alert.window.makeFirstResponder(field)
    }

    private func confirmDeleteMarker(_ id: String) {
        guard let marker = model.timeline.marker(id: id) else { return }
        let alert = NSAlert()
        alert.messageText = "删除时间标记“\(model.caption(of: marker))”？"
        alert.informativeText = marker.driftNodeId == nil ? "章节和它们在故事时间中的位置不受影响。"
            : "绑定的漂流本身会保留，章节的位置不受影响。"
        alert.addButton(withTitle: "删除").setAccessibilityIdentifier("confirm-delete-graph-marker")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.model.deleteMarker(id: id)
        }
    }

    private func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, completion); return }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: completion) }
        else { completion(alert.runModal()) }
    }
}

/// The story graph's document view: lane bands, chapter cards placed by the
/// axis, the 未放置 tray, the marker row and the drift area. Card views are
/// reused by identity; a render sets frames and text only.
final class StoryGraphCanvas: NSView {
    enum Target: Equatable { case chapter(String), marker(String), drift(String), axis(Double) }
    enum Item: Equatable {
        case chapter(String), marker(String), drift(String)
        var id: String {
            switch self { case .chapter(let id), .marker(let id), .drift(let id): return id }
        }
    }
    private struct Drag {
        let item: Item
        let start: NSPoint
        let origin: NSPoint
        var moved = false
    }
    typealias M = StoryGraphMetrics

    let model: StoryGraphModel
    let rail = StoryGraphRail()
    let dropIndicator = StoryGraphBand()
    private(set) var laneBands: [StoryGraphBand] = []
    private let trayBand = StoryGraphBand()
    private let driftBand = StoryGraphBand()
    private let axisLine = StoryGraphBand()
    private let axisCaption = NSTextField(labelWithString: "")
    private let trayCaption = NSTextField(labelWithString: "")
    private let driftCaption = NSTextField(labelWithString: "")
    private(set) var cardViews: [String: StoryGraphCardView] = [:]
    private(set) var markerViews: [String: StoryGraphMarkerView] = [:]
    private(set) var driftViews: [String: StoryGraphCardView] = [:]
    private(set) var lanes: [StoryGraphModel.Lane] = []
    /// The x centre of each shown chapter's slot on the axis or in the tray.
    private(set) var centers: [String: CGFloat] = [:]
    /// Narrative order → x through the placed chapters' slots.
    private var anchors: [(order: Double, x: CGFloat)] = []
    private(set) var lanesTop: CGFloat = M.axisHeight
    private(set) var trayTop: CGFloat = 0
    private(set) var driftTop: CGFloat = 0
    var driftAreaTop: CGFloat { driftTop + M.driftHeader }
    private var drag: Drag?
    /// A dropped item keeps its place until the reply lays it out.
    private var pendingDrop: String?
    /// Renders so far, for acceptance: a drag renders nothing.
    private(set) var renders = 0

    var onDropChapter: ((String, String??, StoryGraphModel.Placement?) -> Void)?
    var onDropMarker: ((String, Double) -> Void)?
    var onDropDrift: ((String, Double, Double) -> Void)?
    var onOpenChapter: ((String) -> Void)?
    var onOpenDrift: ((String) -> Void)?
    var onEditMarker: ((String) -> Void)?
    var menuProvider: ((Target) -> NSMenu?)?

    init(model: StoryGraphModel) {
        self.model = model
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 400))
        wantsLayer = true
        setAccessibilityIdentifier("story-graph-canvas")
        for band in [trayBand, driftBand] { addSubview(band) }
        trayBand.setAccessibilityIdentifier("graph-tray")
        driftBand.setAccessibilityIdentifier("graph-drift-area")
        axisLine.tint = .separatorColor; axisLine.alpha = 1
        addSubview(axisLine)
        for label in [axisCaption, trayCaption, driftCaption] {
            label.font = .systemFont(ofSize: 11)
            label.textColor = .tertiaryLabelColor
            addSubview(label)
        }
        dropIndicator.tint = .controlAccentColor; dropIndicator.alpha = 0.9
        dropIndicator.isHidden = true
        dropIndicator.setAccessibilityIdentifier("graph-drop-indicator")
        addSubview(dropIndicator)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }

    // MARK: Render

    func render() {
        renders += 1
        let narrative = model.axis == .narrative
        lanes = model.lanes
        let axisChapters = model.axisChapters
        var index: [String: Int] = [:]
        for (position, chapter) in axisChapters.enumerated() { index[chapter.id] = position }
        let unplaced = narrative ? model.unplacedChapters : []
        let lanesHeight = CGFloat(lanes.count) * M.laneHeight
        trayTop = lanesTop + lanesHeight + (narrative ? M.trayGap : 0)
        driftTop = (narrative ? trayTop + M.trayHeight : lanesTop + lanesHeight) + M.driftGap
        let conversion = narrative ? model.conversion : nil

        // Drift card places, for the canvas size.
        var driftFrames: [(WorkspaceDrift, NSRect)] = []
        var flow = 0
        for card in model.driftCards {
            let origin: NSPoint
            if let position = card.position {
                origin = NSPoint(x: M.contentLeft + position.x, y: driftAreaTop + position.y)
            } else {
                let column = flow % M.driftsPerRow, row = flow / M.driftsPerRow
                flow += 1
                origin = NSPoint(x: M.contentLeft + 12 + CGFloat(column) * (M.driftCard.width + 12),
                                 y: driftAreaTop + 12 + CGFloat(row) * (M.driftCard.height + 12))
            }
            driftFrames.append((card.drift, NSRect(origin: origin, size: M.driftCard)))
        }
        let driftBottom = max(driftAreaTop + M.driftAreaMinHeight, (driftFrames.map(\.1.maxY).max() ?? 0) + 24)
        let slots = max(axisChapters.count, unplaced.count, 1)
        let visible = enclosingScrollView?.contentSize ?? .zero
        let width = max(M.contentLeft + CGFloat(slots) * M.slot + M.gutter * 2,
                        (driftFrames.map(\.1.maxX).max() ?? 0) + M.gutter * 2, visible.width)
        let height = max(driftBottom + M.gutter, visible.height)
        if frame.size != NSSize(width: width, height: height) { setFrameSize(NSSize(width: width, height: height)) }

        // Lane bands.
        while laneBands.count < lanes.count {
            let band = StoryGraphBand()
            addSubview(band, positioned: .below, relativeTo: nil)
            laneBands.append(band)
        }
        while laneBands.count > lanes.count { laneBands.removeLast().removeFromSuperview() }
        for (position, lane) in lanes.enumerated() {
            let band = laneBands[position]
            band.frame = NSRect(x: 0, y: lanesTop + CGFloat(position) * M.laneHeight, width: width, height: M.laneHeight - 2)
            band.tint = lane.color.flatMap(ElementSwatch.color(hex:)) ?? .secondaryLabelColor
            band.alpha = lane.color == nil ? 0.04 : 0.06
            band.setAccessibilityIdentifier("graph-lane-\(lane.identifier)")
            band.setAccessibilityLabel("\(lane.name)，\(lane.chapterIDs.count) 章")
        }
        trayBand.isHidden = !narrative; trayCaption.isHidden = !narrative
        trayBand.frame = NSRect(x: 0, y: trayTop, width: width, height: M.trayHeight - 4)
        trayBand.tint = .secondaryLabelColor; trayBand.alpha = 0.07
        trayCaption.stringValue = unplaced.isEmpty ? "所有章节都已放进故事时间" : "未放置 · 拖到轨道上，放进故事时间"
        trayCaption.frame = NSRect(x: M.contentLeft, y: trayTop + 4, width: 360, height: 14)
        driftBand.frame = NSRect(x: 0, y: driftTop, width: width, height: driftBottom - driftTop)
        driftBand.tint = .secondaryLabelColor; driftBand.alpha = 0.035
        driftCaption.stringValue = model.drifts.drifts.isEmpty ? "漂流 · 还没有漂流" : "漂流 · 拖动卡片自由摆放，双击打开"
        driftCaption.frame = NSRect(x: M.contentLeft, y: driftTop + 7, width: 360, height: 14)
        axisCaption.stringValue = narrative ? (conversion == nil ? "故事时间 →" : "故事时间 → · 按带数字的标记换算") : "成书顺序 →"
        axisCaption.frame = NSRect(x: M.contentLeft, y: 4, width: 280, height: 14)
        axisLine.frame = NSRect(x: M.contentLeft, y: lanesTop - 7, width: width - M.contentLeft - M.gutter, height: 1)
        axisLine.isHidden = !narrative

        // Chapter cards on the axis and in the tray.
        var shown = Set<String>()
        var centers: [String: CGFloat] = [:]
        func place(_ chapter: WorkspaceChapter, center: CGFloat, top: CGFloat, color: String?) {
            shown.insert(chapter.id)
            centers[chapter.id] = center
            let view = cardViews[chapter.id] ?? makeCard(chapter.id)
            let bookNumber = (model.bookIndex(of: chapter.id) ?? 0) + 1
            var meta = [String(format: "§ %02d", bookNumber)]
            if let status = chapter.writingStatus, status != "draft" { meta.append(WritingStatus.label(status)) }
            if let count = model.wordCount(of: chapter.id) { meta.append(WordCountText.compact(count)) }
            if let conversion, let order = model.narrativeOrder(of: chapter.id), let time = conversion.time(order: order) {
                meta.append("≈ \(TimelineConversion.text(time))")
            }
            view.show(title: chapter.title.isEmpty ? "未命名章节" : chapter.title, meta: meta.joined(separator: " · "),
                      tint: color.flatMap(ElementSwatch.color(hex:)), dimmed: chapter.writingStatus == "discarded")
            view.toolTip = model.wordCount(of: chapter.id).map { "\(chapter.title) · \(WordCountText.full($0))" } ?? "\(chapter.title) · 字数统计中"
            view.setAccessibilityLabel("第 \(bookNumber) 章 \(chapter.title)")
            let frame = NSRect(x: center - M.card.width / 2, y: top, width: M.card.width, height: M.card.height)
            if pendingDrop != chapter.id || !model.busy { view.frame = frame }
        }
        for (position, lane) in lanes.enumerated() {
            let top = lanesTop + CGFloat(position) * M.laneHeight + (M.laneHeight - 2 - M.card.height) / 2
            for id in lane.chapterIDs {
                guard let chapter = model.chapter(id: id), let slot = index[id] else { continue }
                place(chapter, center: M.slotCenter(slot), top: top, color: lane.color)
            }
        }
        for (slot, chapter) in unplaced.enumerated() {
            place(chapter, center: M.slotCenter(slot), top: trayTop + 22, color: model.primary(of: chapter.id)
                .flatMap { model.storylines.storyline(id: $0)?.color })
        }
        for (id, view) in cardViews where !shown.contains(id) { view.removeFromSuperview(); cardViews[id] = nil }
        self.centers = centers

        // Narrative anchors: each distinct order at the mean of its slots.
        var groups: [(order: Double, sum: CGFloat, count: CGFloat)] = []
        if narrative {
            for chapter in model.placedChapters {
                guard let order = model.narrativeOrder(of: chapter.id), let x = centers[chapter.id] else { continue }
                if let last = groups.last, last.order == order {
                    groups[groups.count - 1].sum += x; groups[groups.count - 1].count += 1
                } else { groups.append((order, x, 1)) }
            }
        }
        anchors = groups.map { ($0.order, $0.sum / $0.count) }

        // Markers on the narrative axis.
        var shownMarkers = Set<String>()
        if narrative {
            for marker in model.markers {
                shownMarkers.insert(marker.id)
                let view = markerViews[marker.id] ?? makeMarker(marker.id)
                let caption = model.caption(of: marker)
                view.show(caption: caption, bound: marker.driftNodeId != nil)
                view.setAccessibilityLabel("时间标记 \(caption)")
                view.toolTip = marker.driftNodeId == nil ? "\(caption) · 拖动调整位置，双击重命名"
                    : "\(caption) · 已绑定漂流 · 拖动调整位置，双击重命名"
                let size = view.fittingWidth
                let x = min(max(markerX(order: marker.narrativeOrder), M.contentLeft + size / 2), width - size / 2 - 4)
                if pendingDrop != marker.id || !model.busy {
                    view.frame = NSRect(x: x - size / 2, y: 18, width: size, height: 20)
                }
            }
        }
        for (id, view) in markerViews where !shownMarkers.contains(id) { view.removeFromSuperview(); markerViews[id] = nil }

        // Drift cards.
        var shownDrifts = Set<String>()
        for (drift, frame) in driftFrames {
            shownDrifts.insert(drift.id)
            let view = driftViews[drift.id] ?? makeDrift(drift.id)
            var meta = ["漂流"]
            if let count = model.wordCount(of: drift.id) { meta.append(WordCountText.compact(count)) }
            if model.markers.contains(where: { $0.driftNodeId == drift.id }) { meta.append("已绑定标记") }
            view.show(title: drift.title.isEmpty ? "未命名漂流" : drift.title, meta: meta.joined(separator: " · "), tint: nil, dimmed: false)
            view.toolTip = "\(drift.title) · 拖动摆放，双击打开"
            view.setAccessibilityLabel("漂流 \(drift.title)")
            if pendingDrop != drift.id || !model.busy { view.frame = frame }
        }
        for (id, view) in driftViews where !shownDrifts.contains(id) { view.removeFromSuperview(); driftViews[id] = nil }
        if !model.busy { pendingDrop = nil }
        rail.show(lanes: lanes, lanesTop: lanesTop, narrative: narrative, trayTop: trayTop, driftTop: driftTop,
                  height: height, unplaced: unplaced.count)
    }

    private func makeCard(_ id: String) -> StoryGraphCardView {
        let view = StoryGraphCardView(item: .chapter(id), canvas: self, size: M.card)
        view.setAccessibilityIdentifier("graph-card-\(id)")
        addSubview(view, positioned: .below, relativeTo: dropIndicator)
        cardViews[id] = view
        return view
    }

    private func makeDrift(_ id: String) -> StoryGraphCardView {
        let view = StoryGraphCardView(item: .drift(id), canvas: self, size: M.driftCard)
        view.setAccessibilityIdentifier("graph-drift-\(id)")
        addSubview(view, positioned: .below, relativeTo: dropIndicator)
        driftViews[id] = view
        return view
    }

    private func makeMarker(_ id: String) -> StoryGraphMarkerView {
        let view = StoryGraphMarkerView(item: .marker(id), canvas: self)
        view.setAccessibilityIdentifier("graph-marker-\(id)")
        addSubview(view, positioned: .below, relativeTo: dropIndicator)
        markerViews[id] = view
        return view
    }

    // MARK: Narrative axis mapping

    /// Where a narrative order sits: linear between the placed chapters'
    /// slots, one slot per unit beyond them (and on an empty axis).
    func markerX(order: Double) -> CGFloat {
        guard let first = anchors.first, let last = anchors.last else {
            return M.slotCenter(0) + CGFloat(order - 1) * M.slot
        }
        if order <= first.order { return first.x + CGFloat(order - first.order) * M.slot }
        if order >= last.order { return last.x + CGFloat(order - last.order) * M.slot }
        for (left, right) in zip(anchors, anchors.dropFirst()) where order <= right.order {
            return left.x + CGFloat((order - left.order) / (right.order - left.order)) * (right.x - left.x)
        }
        return last.x
    }

    /// The inverse of `markerX`, rounded to 1/10000.
    func markerOrder(x: CGFloat) -> Double {
        let order: Double
        if let first = anchors.first, let last = anchors.last {
            if x <= first.x { order = first.order + Double((x - first.x) / M.slot) }
            else if x >= last.x { order = last.order + Double((x - last.x) / M.slot) }
            else {
                var value = last.order
                for (left, right) in zip(anchors, anchors.dropFirst()) where x <= right.x {
                    value = left.order + Double((x - left.x) / (right.x - left.x)) * (right.order - left.order)
                    break
                }
                order = value
            }
        } else { order = 1 + Double((x - M.slotCenter(0)) / M.slot) }
        return (order * 10000).rounded() / 10000
    }

    // MARK: Drops

    /// The lane (nil: unchanged) and axis placement (nil: unchanged) of a
    /// chapter card whose centre is at `center`.
    func chapterDrop(_ id: String, center: NSPoint) -> (lane: String??, placement: StoryGraphModel.Placement?) {
        let narrative = model.axis == .narrative
        let placed = model.narrativeOrder(of: id) != nil
        if narrative, center.y >= trayTop - M.trayGap / 2, center.y < driftTop {
            return (nil, placed ? .narrative(nil) : nil)
        }
        guard center.y < driftTop - M.driftGap / 2, !lanes.isEmpty else { return (nil, nil) }
        let laneIndex = min(max(Int(floor((center.y - lanesTop) / M.laneHeight)), 0), lanes.count - 1)
        let target = lanes[laneIndex].storylineID
        let lane: String?? = model.storylines.storylines.isEmpty || target == model.primary(of: id) ? nil : .some(target)
        let others = model.axisChapters.filter { $0.id != id }
        let count = others.filter { (centers[$0.id] ?? .greatestFiniteMagnitude) < center.x }.count
        let placement: StoryGraphModel.Placement?
        if narrative {
            placement = model.narrativeOrder(moving: id, toIndex: count).map { .narrative($0) }
        } else {
            placement = model.bookDestination(moving: id, toIndex: count).map { .book(before: $0) }
        }
        return (lane, placement)
    }

    private func indicator(for id: String, center: NSPoint) {
        let narrative = model.axis == .narrative
        guard center.y < (narrative ? trayTop - M.trayGap / 2 : driftTop - M.driftGap / 2), !lanes.isEmpty else {
            dropIndicator.isHidden = true; return
        }
        let laneIndex = min(max(Int(floor((center.y - lanesTop) / M.laneHeight)), 0), lanes.count - 1)
        let others = model.axisChapters.filter { $0.id != id }.compactMap { centers[$0.id] }
        let count = others.filter { $0 < center.x }.count
        let x = count < others.count ? others[count] - M.slot / 2 : (others.last.map { $0 + M.slot / 2 } ?? M.contentLeft)
        dropIndicator.frame = NSRect(x: x - 1, y: lanesTop + CGFloat(laneIndex) * M.laneHeight + 6, width: 2, height: M.laneHeight - 14)
        dropIndicator.isHidden = false
    }

    // MARK: Mouse

    func mouseDown(_ item: Item, view: NSView, event: NSEvent) {
        if event.clickCount >= 2 {
            drag = nil
            switch item {
            case .chapter(let id): onOpenChapter?(id)
            case .drift(let id): onOpenDrift?(id)
            case .marker(let id): onEditMarker?(id)
            }
            return
        }
        guard !model.busy, model.loaded else { drag = nil; return }
        drag = Drag(item: item, start: convert(event.locationInWindow, from: nil), origin: view.frame.origin)
    }

    func mouseDragged(_ item: Item, view: NSView, event: NSEvent) {
        guard var drag, drag.item == item else { return }
        let point = convert(event.locationInWindow, from: nil)
        let dx = point.x - drag.start.x, dy = point.y - drag.start.y
        if !drag.moved {
            guard hypot(dx, dy) >= 3 else { return }
            drag.moved = true
            view.layer?.zPosition = 10
            (view as? StoryGraphCardView)?.isLifted = true
        }
        self.drag = drag
        switch item {
        case .chapter(let id):
            view.setFrameOrigin(NSPoint(x: max(M.contentLeft - M.card.width / 2, drag.origin.x + dx), y: max(0, drag.origin.y + dy)))
            indicator(for: id, center: NSPoint(x: view.frame.midX, y: view.frame.midY))
        case .marker:
            view.setFrameOrigin(NSPoint(x: max(M.contentLeft, drag.origin.x + dx), y: drag.origin.y))
        case .drift:
            view.setFrameOrigin(NSPoint(x: max(M.contentLeft + M.driftMargin, drag.origin.x + dx),
                                        y: max(driftAreaTop + M.driftMargin, drag.origin.y + dy)))
        }
        autoscroll(with: event)
    }

    func mouseUp(_ item: Item, view: NSView, event: NSEvent) {
        guard let drag, drag.item == item else { return }
        self.drag = nil
        dropIndicator.isHidden = true
        view.layer?.zPosition = 0
        (view as? StoryGraphCardView)?.isLifted = false
        guard drag.moved else { return }
        pendingDrop = item.id
        switch item {
        case .chapter(let id):
            let drop = chapterDrop(id, center: NSPoint(x: view.frame.midX, y: view.frame.midY))
            onDropChapter?(id, drop.lane, drop.placement)
        case .marker(let id):
            onDropMarker?(id, markerOrder(x: view.frame.midX))
        case .drift(let id):
            onDropDrift?(id, Double((view.frame.minX - M.contentLeft).rounded()), Double((view.frame.minY - driftAreaTop).rounded()))
        }
        // A drop that sent nothing lays the item back at once.
        if !model.busy { pendingDrop = nil; render() }
    }

    func menu(for item: Item) -> NSMenu? {
        switch item {
        case .chapter(let id): return menuProvider?(.chapter(id))
        case .marker(let id): return menuProvider?(.marker(id))
        case .drift(let id): return menuProvider?(.drift(id))
        }
    }

    /// The marker row offers 在此处新建标记… at the clicked order.
    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        guard model.axis == .narrative, point.y < lanesTop, point.x >= M.contentLeft else { return nil }
        return menuProvider?(.axis(markerOrder(x: point.x)))
    }
}

/// A flat wash: a lane, the tray, the drift area, the axis line or the drop
/// indicator. No backing store; the layer colour is resolved per appearance.
final class StoryGraphBand: NSView {
    var tint: NSColor = .secondaryLabelColor { didSet { needsDisplay = true } }
    var alpha: CGFloat = 0.05 { didSet { needsDisplay = true } }
    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var wantsUpdateLayer: Bool { true }
    override var isFlipped: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() { layer?.backgroundColor = tint.withAlphaComponent(alpha).cgColor }
    /// Bands never take clicks from the canvas.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// A chapter or drift card: a rounded wash in its lane's colour with a meta
/// line and a two-line title. Mouse events go to the canvas.
final class StoryGraphCardView: NSView {
    let item: StoryGraphCanvas.Item
    private weak var canvas: StoryGraphCanvas?
    let metaLabel = NSTextField(labelWithString: "")
    let titleLabel = NSTextField(labelWithString: "")
    private var tint: NSColor?
    var isLifted = false { didSet { if isLifted != oldValue { needsDisplay = true } } }

    init(item: StoryGraphCanvas.Item, canvas: StoryGraphCanvas, size: NSSize) {
        self.item = item
        self.canvas = canvas
        super.init(frame: NSRect(origin: .zero, size: size))
        wantsLayer = true
        metaLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        metaLabel.textColor = .secondaryLabelColor
        metaLabel.lineBreakMode = .byTruncatingTail
        titleLabel.font = .systemFont(ofSize: 12.5, weight: .medium)
        titleLabel.maximumNumberOfLines = 2
        titleLabel.cell?.wraps = true
        titleLabel.cell?.truncatesLastVisibleLine = true
        titleLabel.lineBreakMode = .byTruncatingTail
        addSubview(metaLabel); addSubview(titleLabel)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() {
        guard let layer else { return }
        layer.cornerRadius = 8
        layer.backgroundColor = (tint ?? .secondaryLabelColor).withAlphaComponent(isLifted ? 0.3 : (tint == nil ? 0.09 : 0.16)).cgColor
        layer.shadowOpacity = isLifted ? 0.25 : 0
        layer.shadowRadius = 6
        layer.shadowOffset = CGSize(width: 0, height: -2)
    }

    func show(title: String, meta: String, tint: NSColor?, dimmed: Bool) {
        if titleLabel.stringValue != title { titleLabel.stringValue = title }
        if metaLabel.stringValue != meta { metaLabel.stringValue = meta }
        if self.tint != tint { self.tint = tint; needsDisplay = true }
        alphaValue = dimmed ? 0.5 : 1
    }

    override func layout() {
        super.layout()
        metaLabel.frame = NSRect(x: 10, y: 6, width: bounds.width - 20, height: 14)
        titleLabel.frame = NSRect(x: 10, y: 21, width: bounds.width - 20, height: bounds.height - 25)
    }

    /// The whole card takes clicks, not its labels.
    override func hitTest(_ point: NSPoint) -> NSView? { isHidden || !frame.contains(point) ? nil : self }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { canvas?.mouseDown(item, view: self, event: event) }
    override func mouseDragged(with event: NSEvent) { canvas?.mouseDragged(item, view: self, event: event) }
    override func mouseUp(with event: NSEvent) { canvas?.mouseUp(item, view: self, event: event) }
    override func menu(for event: NSEvent) -> NSMenu? { canvas?.menu(for: item) }
}

/// A marker pin on the narrative axis: a small pill with its caption.
final class StoryGraphMarkerView: NSView {
    let item: StoryGraphCanvas.Item
    private weak var canvas: StoryGraphCanvas?
    let captionLabel = NSTextField(labelWithString: "")
    private var bound = false

    init(item: StoryGraphCanvas.Item, canvas: StoryGraphCanvas) {
        self.item = item
        self.canvas = canvas
        super.init(frame: NSRect(x: 0, y: 0, width: 60, height: 20))
        wantsLayer = true
        captionLabel.font = .systemFont(ofSize: 11, weight: .medium)
        captionLabel.lineBreakMode = .byTruncatingTail
        captionLabel.alignment = .center
        addSubview(captionLabel)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The caption's width plus the label's own insets and the pill's margins.
    var fittingWidth: CGFloat {
        let text = (captionLabel.stringValue as NSString).size(withAttributes: [.font: captionLabel.font ?? .systemFont(ofSize: 11)])
        return min(160, max(40, ceil(text.width) + 26))
    }

    func show(caption: String, bound: Bool) {
        if captionLabel.stringValue != caption { captionLabel.stringValue = caption }
        if self.bound != bound { self.bound = bound; needsDisplay = true }
        captionLabel.textColor = bound ? .labelColor : .secondaryLabelColor
    }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() {
        layer?.cornerRadius = 10
        layer?.backgroundColor = (bound ? NSColor.controlAccentColor.withAlphaComponent(0.18)
            : NSColor.secondaryLabelColor.withAlphaComponent(0.12)).cgColor
    }
    override func layout() {
        super.layout()
        captionLabel.frame = NSRect(x: 8, y: 3, width: bounds.width - 16, height: 15)
    }
    override func hitTest(_ point: NSPoint) -> NSView? { isHidden || !frame.contains(point) ? nil : self }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { canvas?.mouseDown(item, view: self, event: event) }
    override func mouseDragged(with event: NSEvent) { canvas?.mouseDragged(item, view: self, event: event) }
    override func mouseUp(with event: NSEvent) { canvas?.mouseUp(item, view: self, event: event) }
    override func menu(for event: NSEvent) -> NSMenu? { canvas?.menu(for: item) }
}

/// Lane names at the leading edge: a colour dot, the name and the chapter
/// count, then 未放置 and 漂流 beside their areas. It floats over the canvas.
final class StoryGraphRail: NSView {
    private var labels: [NSView] = []
    private(set) var laneTitles: [String] = []

    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }

    func show(lanes: [StoryGraphModel.Lane], lanesTop: CGFloat, narrative: Bool, trayTop: CGFloat, driftTop: CGFloat,
              height: CGFloat, unplaced: Int) {
        frame = NSRect(x: 0, y: 0, width: StoryGraphMetrics.rail, height: height)
        labels.forEach { $0.removeFromSuperview() }
        labels = []
        laneTitles = lanes.map(\.name)
        func add(_ title: String, detail: String, color: String?, hollow: Bool, top: CGFloat) {
            let name = NSTextField(labelWithString: title)
            name.font = .systemFont(ofSize: 12.5, weight: .semibold)
            name.lineBreakMode = .byTruncatingTail
            let count = NSTextField(labelWithString: detail)
            count.font = .systemFont(ofSize: 11)
            count.textColor = .tertiaryLabelColor
            let dot = NSImageView(image: color.map(StorylineChip.dot(hex:)) ?? StorylineChip.hollowDot())
            dot.isHidden = !hollow && color == nil
            dot.frame = NSRect(x: 12, y: top + 3, width: 10, height: 10)
            name.frame = NSRect(x: dot.isHidden ? 12 : 28, y: top, width: StoryGraphMetrics.rail - (dot.isHidden ? 18 : 34), height: 16)
            count.frame = NSRect(x: dot.isHidden ? 12 : 28, y: top + 18, width: StoryGraphMetrics.rail - 34, height: 14)
            for view in [dot, name, count] as [NSView] { addSubview(view); labels.append(view) }
        }
        for (index, lane) in lanes.enumerated() {
            add(lane.name, detail: "\(lane.chapterIDs.count) 章", color: lane.color, hollow: lane.storylineID == nil,
                top: lanesTop + CGFloat(index) * StoryGraphMetrics.laneHeight + 22)
        }
        if narrative { add("未放置", detail: "\(unplaced) 章", color: nil, hollow: false, top: trayTop + 26) }
        add("漂流", detail: "", color: nil, hollow: false, top: driftTop + 6)
    }
}
