import AppKit
import QuartzCore

final class ElementOverviewPanel: NSPanel {
    var onClose: (() -> Void)?
    /// The panel became key again, e.g. after edits in the main window.
    var onBecomeKey: (() -> Void)?
    override func close() { super.close(); onClose?() }
    override func becomeKey() { super.becomeKey(); onBecomeKey?() }
}

/// The 设定总览 panel: a toolbar (counts, 漂流, zoom, 重置, 关闭), the selected
/// relation's bar (type, 交换方向, 删除关系), a status line and the canvas.
/// Pinning a category, relation changes and opening a page are the only
/// actions that reach Rust; panning and zooming write nothing.
final class MacElementOverviewViewController: NSViewController {
    let model: ElementOverviewModel
    var onClose: (() -> Void)?
    var onOpenElement: ((WorkspaceElement) -> Void)?
    var onOpenCategory: ((WorkspaceElementCategory) -> Void)?
    var onOpenChapter: ((WorkspaceChapter) -> Void)?
    var onOpenDrift: ((WorkspaceDrift) -> Void)?
    /// Trashes an element through the tab host, which closes its pages.
    var onTrashElement: ((WorkspaceElement) -> Void)?
    /// Presents a confirmation. Nil uses a sheet on the panel; acceptance
    /// answers here without a window.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Presents a sheet window over the panel; nil begins a sheet.
    var presentSheet: ((NSWindow) -> Void)?

    let metaLabel = NSTextField(labelWithString: "")
    let driftButton = NSButton(title: "漂流", target: nil, action: nil)
    let zoomOutButton = NSButton(title: "−", target: nil, action: nil)
    let zoomLabel = NSTextField(labelWithString: "100%")
    let zoomInButton = NSButton(title: "+", target: nil, action: nil)
    let resetButton = NSButton(title: "重置", target: nil, action: nil)
    let edgeBar = NSStackView()
    let edgeLabel = NSTextField(labelWithString: "")
    let edgeTypePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let edgeSwapButton = NSButton(title: "交换方向", target: nil, action: nil)
    let edgeRemoveButton = NSButton(title: "删除关系", target: nil, action: nil)
    let statusLabel = NSTextField(wrappingLabelWithString: "")
    private(set) var canvas: ElementOverviewCanvas!
    /// The open 新建关系 sheet, if any.
    private(set) var relationSheet: OverviewRelationSheet?
    /// The world point centred and the zoom to show first; nil fits the band.
    var initialViewport: ElementOverviewViewport?

    init(model: ElementOverviewModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        canvas = ElementOverviewCanvas(model: model)
        canvas.controller = self
        canvas.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "设定总览")
        title.font = .systemFont(ofSize: 14, weight: .semibold)
        metaLabel.textColor = .secondaryLabelColor
        metaLabel.setAccessibilityIdentifier("overview-meta")
        driftButton.setButtonType(.pushOnPushOff)
        driftButton.target = self; driftButton.action = #selector(toggleDrifts)
        driftButton.setAccessibilityIdentifier("overview-drifts")
        driftButton.toolTip = "显示或隐藏尚未绑定幕或时间标记的漂流，以及它们与设定的关系"
        for (button, identifier, action, tip) in [(zoomOutButton, "overview-zoom-out", #selector(zoomOut), "缩小（⌘−）"),
                                                  (zoomInButton, "overview-zoom-in", #selector(zoomIn), "放大（⌘+）"),
                                                  (resetButton, "overview-reset", #selector(resetView), "回到章节带并恢复 100%（⌘0）")] {
            button.target = self; button.action = action
            button.setAccessibilityIdentifier(identifier)
            button.toolTip = tip
        }
        zoomLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        zoomLabel.textColor = .secondaryLabelColor
        zoomLabel.alignment = .center
        zoomLabel.setAccessibilityIdentifier("overview-zoom")
        let close = NSButton(title: "关闭", target: self, action: #selector(closeOverview))
        close.setAccessibilityIdentifier("close-element-overview")
        let toolbar = NSStackView(views: [title, metaLabel, NSView(), driftButton, zoomOutButton, zoomLabel, zoomInButton, resetButton, close])
        toolbar.spacing = 8
        zoomLabel.widthAnchor.constraint(equalToConstant: 46).isActive = true

        edgeLabel.lineBreakMode = .byTruncatingMiddle
        edgeLabel.setContentCompressionResistancePriority(.init(200), for: .horizontal)
        edgeLabel.setAccessibilityIdentifier("overview-edge-label")
        edgeTypePopup.target = self; edgeTypePopup.action = #selector(edgeTypeChosen)
        edgeTypePopup.setAccessibilityIdentifier("overview-edge-type")
        edgeSwapButton.target = self; edgeSwapButton.action = #selector(swapSelectedEdge)
        edgeSwapButton.setAccessibilityIdentifier("overview-edge-swap")
        edgeRemoveButton.target = self; edgeRemoveButton.action = #selector(removeSelectedEdge)
        edgeRemoveButton.setAccessibilityIdentifier("overview-edge-remove")
        let edgeTitle = NSTextField(labelWithString: "关系")
        edgeTitle.textColor = .secondaryLabelColor
        edgeBar.setViews([edgeTitle, edgeLabel, edgeTypePopup, edgeSwapButton, edgeRemoveButton, NSView()], in: .leading)
        edgeBar.spacing = 8
        edgeBar.isHidden = true
        edgeBar.setAccessibilityIdentifier("overview-edge-bar")
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: 12)
        statusLabel.setAccessibilityIdentifier("overview-status")

        let stack = NSStackView(views: [toolbar, edgeBar, statusLabel, canvas])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -12),
            toolbar.widthAnchor.constraint(equalTo: stack.widthAnchor),
            edgeBar.widthAnchor.constraint(equalTo: stack.widthAnchor),
            statusLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            canvas.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        canvas.setContentHuggingPriority(.init(1), for: .vertical)
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }

    /// The viewport to remember: the world point at the view's centre.
    var viewport: ElementOverviewViewport {
        let centre = canvas.worldPoint(view: CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY))
        return ElementOverviewViewport(centerX: Double(centre.x), centerY: Double(centre.y), zoom: Double(canvas.zoom),
                                       showsDrifts: model.showsDrifts)
    }

    func reload() {
        guard isViewLoaded else { return }
        metaLabel.stringValue = model.loaded ? model.summary : ""
        let drifts = model.unboundDrifts.count
        driftButton.title = drifts > 0 ? "漂流 · \(drifts)" : "漂流"
        driftButton.state = model.showsDrifts ? .on : .off
        driftButton.isEnabled = model.loaded && (drifts > 0 || model.showsDrifts)
        statusLabel.stringValue = linkHint ?? model.status
        statusLabel.textColor = model.statusIsError && linkHint == nil ? .systemRed : .secondaryLabelColor
        canvas.render()
        updateEdgeBar()
        updateZoomLabel()
    }

    private var linkHint: String? {
        guard let source = canvas?.linkSource else { return nil }
        return "从“\(model.name(of: source))”新建关系：点击另一张设定、章节或漂流卡片 · Esc 取消"
    }

    func updateZoomLabel() {
        zoomLabel.stringValue = "\(Int((canvas.zoom * 100).rounded()))%"
    }

    /// A resized panel keeps the world point at its centre.
    override func viewDidLayout() {
        super.viewDidLayout()
        canvas.viewportResized()
    }

    @objc private func toggleDrifts() {
        model.showsDrifts = driftButton.state == .on
    }
    @objc func zoomIn() { canvas.zoom(by: 1.2) }
    @objc func zoomOut() { canvas.zoom(by: 1 / 1.2) }
    @objc func resetView() { canvas.resetView() }
    @objc private func closeOverview() { endRelationSheet(); onClose?() }

    func showStatus(_ text: String, error: Bool = false) { model.showStatus(text, error: error) }

    // MARK: Opening

    func open(_ endpoint: RelationEndpoint) {
        guard !model.busy else { return }
        switch endpoint.kind {
        case "element":
            if let element = model.element(id: endpoint.id) { onOpenElement?(element) }
        default:
            if let drift = model.drift(id: endpoint.id) { onOpenDrift?(drift) }
            else if let chapter = model.chapter(id: endpoint.id) { onOpenChapter?(chapter) }
        }
    }

    func openCategory(key: String) {
        guard let category = model.category(id: key) else { return }
        onOpenCategory?(category)
    }

    // MARK: Menus

    func menu(for target: ElementOverviewCanvas.Target) -> NSMenu? {
        let items = menuItems(for: target)
        guard !items.isEmpty else { return nil }
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in items { menu.addItem(item) }
        return menu
    }

    /// A card's, box's or edge's actions, also used by acceptance.
    func menuItems(for target: ElementOverviewCanvas.Target) -> [NSMenuItem] {
        var items: [NSMenuItem] = []
        switch target {
        case .card(.element, let id):
            guard let element = model.element(id: id) else { return [] }
            items.append(LibraryMenuItem(title: "打开", identifier: "overview-element-open") { [weak self] in
                self?.open(RelationEndpoint(kind: "element", id: id))
            })
            items.append(LibraryMenuItem(title: "从此设定新建关系…", identifier: "overview-element-link") { [weak self] in
                self?.canvas.beginLink(from: RelationEndpoint(kind: "element", id: id))
            })
            items.append(.separator())
            items.append(LibraryMenuItem(title: "移到回收站", identifier: "overview-element-trash") { [weak self] in
                self?.onTrashElement?(element)
            })
        case .card(.chapter, let id):
            items.append(LibraryMenuItem(title: "打开", identifier: "overview-chapter-open") { [weak self] in
                self?.open(RelationEndpoint(kind: "node", id: id))
            })
            items.append(LibraryMenuItem(title: "从此章节新建关系…", identifier: "overview-chapter-link") { [weak self] in
                self?.canvas.beginLink(from: RelationEndpoint(kind: "node", id: id))
            })
        case .card(.drift, let id):
            items.append(LibraryMenuItem(title: "打开", identifier: "overview-drift-open") { [weak self] in
                self?.open(RelationEndpoint(kind: "node", id: id))
            })
            items.append(LibraryMenuItem(title: "从此漂流新建关系…", identifier: "overview-drift-link") { [weak self] in
                self?.canvas.beginLink(from: RelationEndpoint(kind: "node", id: id))
            })
        case .box(let key):
            guard model.category(id: key) != nil else { return [] }
            items.append(LibraryMenuItem(title: "打开分类页", identifier: "overview-category-open") { [weak self] in
                self?.openCategory(key: key)
            })
            if model.layouts[key]?.cell != nil {
                let auto = LibraryMenuItem(title: "恢复自动排列", identifier: "overview-category-auto") { [weak self] in
                    self?.model.unpin(categoryID: key)
                }
                auto.toolTip = "取消固定，让这个分类回到自动排列的位置"
                items.append(auto)
            }
        case .edge(let id):
            guard let edge = model.scene.edge(id) else { return [] }
            let options = model.relations.library.retypeOptions(for: edge.relation)
            let retype = NSMenuItem(title: "改为其他类型", action: nil, keyEquivalent: "")
            retype.setAccessibilityIdentifier("overview-edge-retype")
            let submenu = NSMenu()
            for option in options {
                let item = LibraryMenuItem(title: "\(option.type.displayName)（\(option.type.summary)）\(option.swap ? " · 交换两端" : "")",
                                           identifier: "overview-edge-retype-\(option.type.id)") { [weak self] in
                    self?.model.retypeRelation(id: id, typeID: option.type.id, swap: option.swap)
                }
                item.state = option.type.id == edge.relation.relationTypeId && !option.swap ? .on : .off
                submenu.addItem(item)
            }
            retype.submenu = submenu
            items.append(retype)
            if edge.type?.isSymmetric == false {
                let swap = LibraryMenuItem(title: "交换方向", identifier: "overview-edge-swap-menu") { [weak self] in
                    self?.model.retypeRelation(id: id, typeID: edge.relation.relationTypeId, swap: true)
                }
                swap.isEnabled = canSwap(edge.relation)
                items.append(swap)
            }
            items.append(.separator())
            items.append(LibraryMenuItem(title: "删除关系", identifier: "overview-edge-remove-menu") { [weak self] in
                self?.canvas.select(edge: nil)
                self?.model.removeRelation(id: id)
            })
        }
        for item in items where item is LibraryMenuItem && item.isEnabled { item.isEnabled = !model.busy }
        return items
    }

    // MARK: The selected relation

    private func canSwap(_ relation: WorkspaceRelation) -> Bool {
        guard let type = model.relations.library.type(id: relation.relationTypeId), !type.isSymmetric else { return false }
        return RelationKind.structural.contains(relation.from.kind) && type.check(from: relation.to, to: relation.from).isValid
    }

    /// The selected relation's ends, type and actions; hidden without one.
    func updateEdgeBar() {
        guard let id = canvas.selectedEdge, let edge = model.scene.edge(id) else { edgeBar.isHidden = true; return }
        edgeBar.isHidden = false
        let arrow = edge.type?.isSymmetric == true ? "↔" : "→"
        edgeLabel.stringValue = "\(edge.fromName) \(arrow) \(edge.toName)"
        edgeLabel.toolTip = edge.type.map { "\($0.displayName)：\($0.summary)" } ?? "这条关系的类型已不可用"
        edgeTypePopup.removeAllItems()
        let options = model.relations.library.retypeOptions(for: edge.relation)
        for option in options {
            let item = NSMenuItem(title: "\(option.type.displayName)（\(option.type.summary)）\(option.swap ? " · 交换两端" : "")",
                                  action: nil, keyEquivalent: "")
            item.representedObject = option.type.id + (option.swap ? "|swap" : "")
            item.setAccessibilityIdentifier("overview-edge-type-\(option.type.id)")
            edgeTypePopup.menu?.addItem(item)
        }
        if edge.type == nil {
            let missing = NSMenuItem(title: "缺失的关系类型", action: nil, keyEquivalent: "")
            edgeTypePopup.menu?.insertItem(missing, at: 0)
            edgeTypePopup.selectItem(at: 0)
        } else if let index = edgeTypePopup.itemArray.firstIndex(where: { $0.representedObject as? String == edge.relation.relationTypeId }) {
            edgeTypePopup.selectItem(at: index)
        }
        edgeSwapButton.isHidden = edge.type?.isSymmetric != false
        edgeSwapButton.isEnabled = !model.busy && canSwap(edge.relation)
        edgeTypePopup.isEnabled = !model.busy
        edgeRemoveButton.isEnabled = !model.busy
    }

    /// Chooses a type in the bar's popup, as a click would.
    func chooseEdgeType(_ typeID: String, swap: Bool = false) {
        let value = typeID + (swap ? "|swap" : "")
        guard let index = edgeTypePopup.itemArray.firstIndex(where: { $0.representedObject as? String == value }) else { return }
        edgeTypePopup.selectItem(at: index)
        edgeTypeChosen()
    }

    @objc private func edgeTypeChosen() {
        guard let id = canvas.selectedEdge, let value = edgeTypePopup.selectedItem?.representedObject as? String else { return }
        let parts = value.split(separator: "|")
        model.retypeRelation(id: id, typeID: String(parts[0]), swap: parts.count > 1)
    }

    @objc func swapSelectedEdge() {
        guard let id = canvas.selectedEdge, let relation = model.relations.library.relation(id: id) else { return }
        model.retypeRelation(id: id, typeID: relation.relationTypeId, swap: true)
    }

    @objc func removeSelectedEdge() {
        guard let id = canvas.selectedEdge else { return }
        canvas.select(edge: nil)
        model.removeRelation(id: id)
    }

    // MARK: New relation

    /// 新建关系 between two cards: the direction, 交换方向 and a type that fits
    /// both ends. Rust decides; its refusal (a self relation included) stays
    /// in the sheet in Chinese.
    func beginRelation(from: RelationEndpoint, to: RelationEndpoint) {
        guard relationSheet == nil, !model.busy else { return }
        let sheet = OverviewRelationSheet(model: model, from: from, to: to)
        relationSheet = sheet
        sheet.onFinish = { [weak self, weak sheet] relation in
            guard let self, let sheet, self.relationSheet === sheet else { return }
            self.relationSheet = nil
            if let parent = sheet.window.sheetParent { parent.endSheet(sheet.window) } else { sheet.window.orderOut(nil) }
            if let relation {
                self.showStatus("已新建关系：\(self.model.name(of: relation.from)) → \(self.model.name(of: relation.to))。")
                self.canvas.select(edge: relation.id)
            }
        }
        if let presentSheet { presentSheet(sheet.window) }
        else if let window = view.window { window.beginSheet(sheet.window) }
    }

    func endRelationSheet() { relationSheet?.cancel() }

    func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, completion); return }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: completion) }
        else { completion(alert.runModal()) }
    }
}

// MARK: - Canvas

/// The overview's world: category boxes holding element cards, the chapter
/// band and the 漂流 row, drawn as layers and moved by one transform for pan
/// and zoom. Hit testing uses the scene, so no view per card exists.
final class ElementOverviewCanvas: NSView {
    typealias M = ElementOverviewMetrics

    enum Target: Equatable {
        case card(ElementOverviewScene.Kind, String)
        case box(String)
        case edge(String)
    }

    private enum Gesture {
        case pan(start: CGPoint, origin: CGPoint)
        case box(key: String, start: CGPoint, origin: CGPoint)
        case link(from: RelationEndpoint, start: CGPoint)
    }

    let model: ElementOverviewModel
    weak var controller: MacElementOverviewViewController?
    private let worldLayer = CALayer()
    private let bandContainer = CALayer()
    private let bandBackground = CALayer()
    private let driftContainer = CALayer()
    private let boxContainer = CALayer()
    private let edgeContainer = CALayer()
    private let selectedEdgeLayer = CAShapeLayer()
    private let linkLayer = CAShapeLayer()
    private var boxLayers: [String: OverviewBoxLayer] = [:]
    private var cardLayers: [String: OverviewCardLayer] = [:]
    private var laneLayers: [OverviewTextLayer] = []
    private var laneRules: [CALayer] = []
    private var actLayers: [String: (wash: CALayer, text: OverviewTextLayer)] = [:]
    private var transitLayers: [CAShapeLayer] = []
    private var edgeLayers: [String: CAShapeLayer] = [:]
    private let driftWash = CALayer()
    private let driftCaption = OverviewTextLayer()
    private let emptyCaption = OverviewTextLayer()

    private(set) var pan = CGPoint.zero
    private(set) var zoom: CGFloat = 1
    private var placed = false
    private var lastSize = CGSize.zero
    private var gesture: Gesture?
    private var pressed: (target: ElementOverviewScene.Hit, point: CGPoint, flags: NSEvent.ModifierFlags, clicks: Int)?
    private var moved = false
    private(set) var selectedEdge: String?
    private(set) var linkSource: RelationEndpoint?
    private var sharpenWork: DispatchWorkItem?

    /// Renders so far and the longest main-thread pass (render, pan or
    /// zoom), for acceptance.
    private(set) var renders = 0
    private(set) var slowestPass: TimeInterval = 0
    private(set) var slowestSolver: TimeInterval = 0
    func resetTiming() { slowestPass = 0; slowestSolver = 0 }

    init(model: ElementOverviewModel) {
        self.model = model
        super.init(frame: NSRect(x: 0, y: 0, width: 900, height: 560))
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        setAccessibilityIdentifier("element-overview-canvas")
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("设定总览画布")
        for layer in [worldLayer, bandContainer, driftContainer, boxContainer, edgeContainer] {
            layer.anchorPoint = .zero
            layer.position = .zero
            layer.bounds = .zero
            layer.masksToBounds = false
        }
        bandContainer.addSublayer(bandBackground)
        for layer in [bandContainer, driftContainer, boxContainer, edgeContainer] { worldLayer.addSublayer(layer) }
        selectedEdgeLayer.fillColor = nil
        selectedEdgeLayer.lineWidth = 2.4
        selectedEdgeLayer.lineCap = .round
        worldLayer.addSublayer(selectedEdgeLayer)
        linkLayer.fillColor = nil
        linkLayer.lineWidth = 1.6
        linkLayer.lineDashPattern = [5, 4]
        worldLayer.addSublayer(linkLayer)
        driftWash.cornerRadius = 4
        driftContainer.addSublayer(driftWash)
        driftContainer.addSublayer(driftCaption)
        emptyCaption.isHidden = true
        layer?.addSublayer(worldLayer)
        layer?.addSublayer(emptyCaption)
        layer?.masksToBounds = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
    }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
        for layer in cardLayers.values { layer.setNeedsDisplay() }
        for layer in boxLayers.values { layer.redrawText() }
        render()
    }
    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        render()
    }

    private func timed(_ work: () -> Void) {
        let started = Date()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        work()
        CATransaction.commit()
        slowestPass = max(slowestPass, Date().timeIntervalSince(started))
    }

    // MARK: Coordinates

    func viewPoint(world point: CGPoint) -> CGPoint { CGPoint(x: pan.x + zoom * point.x, y: pan.y + zoom * point.y) }
    func worldPoint(view point: CGPoint) -> CGPoint { CGPoint(x: (point.x - pan.x) / zoom, y: (point.y - pan.y) / zoom) }
    /// The world rectangle in view.
    var visibleWorld: CGRect {
        let origin = worldPoint(view: .zero)
        return CGRect(x: origin.x, y: origin.y, width: bounds.width / zoom, height: bounds.height / zoom)
    }

    private func applyTransform() {
        worldLayer.setAffineTransform(CGAffineTransform(translationX: pan.x, y: pan.y).scaledBy(x: zoom, y: zoom))
        controller?.updateZoomLabel()
    }

    /// Centres the band at 100%, or the remembered viewport the first time.
    func resetView() {
        timed {
            zoom = 1
            let band = model.scene.bandFrame
            pan = CGPoint(x: bounds.midX - band.midX, y: bounds.midY - band.midY)
            applyTransform()
        }
        scheduleSharpen()
    }

    func center(on point: CGPoint, zoom: CGFloat) {
        timed {
            self.zoom = min(max(zoom, M.zoomRange.lowerBound), M.zoomRange.upperBound)
            pan = CGPoint(x: bounds.midX - self.zoom * point.x, y: bounds.midY - self.zoom * point.y)
            applyTransform()
        }
        scheduleSharpen()
    }

    /// A resized view keeps its centre.
    func viewportResized() {
        guard bounds.size != lastSize else { return }
        if placed, lastSize != .zero {
            let centre = CGPoint(x: (lastSize.width / 2 - pan.x) / zoom, y: (lastSize.height / 2 - pan.y) / zoom)
            lastSize = bounds.size
            center(on: centre, zoom: zoom)
        } else {
            lastSize = bounds.size
        }
        emptyCaption.frame = bounds.insetBy(dx: 40, dy: bounds.height / 2 - 20)
    }

    /// Pans by a view-space offset.
    func pan(by delta: CGPoint) {
        timed {
            pan.x += delta.x; pan.y += delta.y
            applyTransform()
        }
        scheduleSharpen()
    }

    /// Zooms around a view point (the centre by default), within 40%–200%.
    func zoom(by factor: CGFloat, around anchor: CGPoint? = nil) {
        let point = anchor ?? CGPoint(x: bounds.midX, y: bounds.midY)
        let next = min(max(zoom * factor, M.zoomRange.lowerBound), M.zoomRange.upperBound)
        guard next != zoom else { return }
        timed {
            let world = worldPoint(view: point)
            zoom = next
            pan = CGPoint(x: point.x - zoom * world.x, y: point.y - zoom * world.y)
            applyTransform()
        }
        scheduleSharpen()
    }

    /// After panning or zooming settles, cards in view are drawn at the
    /// zoom's resolution; others keep the screen's.
    private func scheduleSharpen() {
        sharpenWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.sharpen() }
        sharpenWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
    }

    func sharpen() {
        timed {
            let base = window?.backingScaleFactor ?? 2
            let sharp = zoom > 1.1 ? base * min(2, (zoom * 2).rounded(.up) / 2) : base
            let visible = visibleWorld
            for layer in cardLayers.values {
                let scale = layer.worldFrame.intersects(visible) ? sharp : base
                if layer.contentsScale != scale { layer.contentsScale = scale; layer.setNeedsDisplay(); layer.displayIfNeeded() }
            }
        }
    }

    // MARK: Render

    func render() {
        timed { renderScene() }
    }

    private func renderScene() {
        renders += 1
        let scene = model.scene
        slowestSolver = max(slowestSolver, scene.solverSeconds)
        let scale = window?.backingScaleFactor ?? 2
        var colors: (paper: CGColor, ink: CGColor, rule: CGColor, wash: CGColor, accent: CGColor) = (NSColor.white.cgColor, NSColor.black.cgColor,
            NSColor.gray.cgColor, NSColor.gray.cgColor, NSColor.systemBlue.cgColor)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            colors = (NSColor.textBackgroundColor.cgColor, NSColor.secondaryLabelColor.cgColor, NSColor.separatorColor.cgColor,
                      NSColor.secondaryLabelColor.withAlphaComponent(0.06).cgColor, NSColor.labAccent.cgColor)
        }
        emptyCaption.isHidden = !(model.loaded && scene.boxes.isEmpty)
        if !emptyCaption.isHidden {
            emptyCaption.show(OverviewTextLayer.Content(text: "还没有设定分类。在设定库中新建分类后，它们会排在章节带的上下。",
                                                         size: 13, weight: .regular, colorRole: .secondary, alignment: .center), in: self, scale: scale)
        }

        // Band.
        bandBackground.frame = scene.bandFrame
        bandBackground.backgroundColor = colors.wash
        bandBackground.borderColor = colors.rule
        bandBackground.borderWidth = 0.5
        while laneLayers.count < scene.lanes.count {
            let text = OverviewTextLayer(); bandContainer.addSublayer(text); laneLayers.append(text)
            let rule = CALayer(); bandContainer.addSublayer(rule); laneRules.append(rule)
        }
        while laneLayers.count > scene.lanes.count { laneLayers.removeLast().removeFromSuperlayer(); laneRules.removeLast().removeFromSuperlayer() }
        for (index, lane) in scene.lanes.enumerated() {
            laneLayers[index].frame = CGRect(x: lane.frame.minX + 10, y: lane.frame.minY + 8, width: M.laneGutter - 16, height: lane.frame.height - 16)
            laneLayers[index].show(OverviewTextLayer.Content(text: lane.name, detail: "\(lane.count) 章", size: 11, weight: .semibold,
                                                             colorRole: .primary, dotHex: lane.colorHex, hollowDot: lane.storylineID == nil),
                                   in: self, scale: scale)
            laneRules[index].frame = CGRect(x: lane.frame.minX, y: lane.frame.maxY - 0.5, width: lane.frame.width, height: 0.5)
            laneRules[index].backgroundColor = colors.rule
            laneRules[index].isHidden = index == scene.lanes.count - 1
        }
        var liveActs = Set<String>()
        for act in scene.acts {
            liveActs.insert(act.id)
            let pair = actLayers[act.id] ?? {
                let wash = CALayer(), text = OverviewTextLayer()
                bandContainer.addSublayer(wash); bandContainer.addSublayer(text)
                actLayers[act.id] = (wash, text)
                return (wash, text)
            }()
            pair.wash.frame = act.frame
            pair.wash.cornerRadius = 3
            pair.wash.backgroundColor = (ElementSwatch.color(hex: act.colorHex) ?? .secondaryLabelColor).withAlphaComponent(0.18).cgColor
            pair.text.frame = act.frame.insetBy(dx: 6, dy: 2)
            pair.text.show(OverviewTextLayer.Content(text: act.title, detail: "\(act.count) 章", size: 10.5, weight: .medium, colorRole: .primary),
                           in: self, scale: scale)
        }
        for (id, pair) in actLayers where !liveActs.contains(id) {
            pair.wash.removeFromSuperlayer(); pair.text.removeFromSuperlayer(); actLayers[id] = nil
        }
        while transitLayers.count < scene.transits.count {
            let line = CAShapeLayer(); line.lineDashPattern = [3, 3]; line.lineWidth = 1; line.opacity = 0.55; line.fillColor = nil
            bandContainer.addSublayer(line); transitLayers.append(line)
        }
        while transitLayers.count > scene.transits.count { transitLayers.removeLast().removeFromSuperlayer() }
        for (layer, transit) in zip(transitLayers, scene.transits) {
            let path = CGMutablePath(); path.move(to: transit.from); path.addLine(to: transit.to)
            layer.path = path
            layer.strokeColor = (transit.colorHex.flatMap(ElementSwatch.color(hex:)) ?? .secondaryLabelColor).cgColor
        }

        // Boxes and their element cards.
        var liveBoxes = Set<String>(), liveCards = Set<String>()
        for box in scene.boxes {
            liveBoxes.insert(box.key)
            let layer = boxLayers[box.key] ?? {
                let layer = OverviewBoxLayer()
                boxContainer.addSublayer(layer)
                boxLayers[box.key] = layer
                return layer
            }()
            if !isDragging(box: box.key) { layer.frame = box.frame }
            layer.show(box, in: self, scale: scale, paper: colors.paper, rule: colors.rule)
        }
        for card in scene.cards {
            liveCards.insert(card.key)
            let layer = cardLayers[card.key] ?? {
                let layer = OverviewCardLayer()
                layer.host = self
                layer.contentsScale = scale
                cardLayers[card.key] = layer
                return layer
            }()
            let parent: CALayer
            let frame: CGRect
            switch card.kind {
            case .element:
                guard let key = card.boxKey, let box = boxLayers[key], let sceneBox = scene.box(key) else { continue }
                parent = box
                frame = card.frame.offsetBy(dx: -sceneBox.frame.minX, dy: -sceneBox.frame.minY)
            case .chapter: parent = bandContainer; frame = card.frame
            case .drift: parent = driftContainer; frame = card.frame
            }
            if layer.superlayer !== parent { layer.removeFromSuperlayer(); parent.addSublayer(layer) }
            layer.frame = frame
            layer.worldFrame = card.frame
            layer.content = OverviewCardLayer.Content(kind: card.kind, title: card.title, detail: card.detail, colorHex: card.colorHex,
                                                      dimmed: card.dimmed, linkSource: linkSource == card.endpoint)
            layer.displayIfNeeded()
        }
        for (key, layer) in boxLayers where !liveBoxes.contains(key) { layer.removeFromSuperlayer(); boxLayers[key] = nil }
        for (key, layer) in cardLayers where !liveCards.contains(key) { layer.removeFromSuperlayer(); cardLayers[key] = nil }

        // The 漂流 row.
        driftContainer.isHidden = scene.driftArea == nil
        if let area = scene.driftArea {
            driftWash.frame = area
            driftWash.backgroundColor = colors.wash
            driftCaption.frame = CGRect(x: area.minX + M.driftGap, y: area.minY + 2, width: area.width - 2 * M.driftGap, height: 18)
            driftCaption.show(OverviewTextLayer.Content(text: "漂流", detail: "尚未绑定幕或时间标记的 \(scene.cards.filter { $0.kind == .drift }.count) 条",
                                                         size: 11, weight: .semibold, colorRole: .secondary), in: self, scale: scale)
        }

        // Edges, one path per colour, and the selected edge on top.
        if let selected = selectedEdge, scene.edge(selected) == nil { selectedEdge = nil }
        var paths: [String: CGMutablePath] = [:]
        for edge in scene.edges where edge.id != selectedEdge {
            let path = paths[edge.colorHex] ?? CGMutablePath()
            Self.add(edge, to: path)
            paths[edge.colorHex] = path
        }
        for (hex, path) in paths {
            let layer = edgeLayers[hex] ?? {
                let layer = CAShapeLayer()
                layer.fillColor = nil; layer.lineWidth = 1.6; layer.opacity = 0.78; layer.lineCap = .round; layer.lineJoin = .round
                edgeContainer.addSublayer(layer)
                edgeLayers[hex] = layer
                return layer
            }()
            layer.path = path
            layer.strokeColor = (ElementSwatch.color(hex: hex) ?? .secondaryLabelColor).cgColor
        }
        for (hex, layer) in edgeLayers where paths[hex] == nil { layer.removeFromSuperlayer(); edgeLayers[hex] = nil }
        if let id = selectedEdge, let edge = scene.edge(id) {
            let path = CGMutablePath()
            Self.add(edge, to: path)
            selectedEdgeLayer.path = path
            selectedEdgeLayer.strokeColor = (ElementSwatch.color(hex: edge.colorHex) ?? .labAccent).cgColor
            selectedEdgeLayer.isHidden = false
        } else {
            selectedEdgeLayer.path = nil
            selectedEdgeLayer.isHidden = true
        }
        linkLayer.strokeColor = colors.accent

        if !placed, model.loaded, bounds.width > 0 {
            placed = true
            lastSize = bounds.size
            if let viewport = controller?.initialViewport {
                zoom = min(max(CGFloat(viewport.zoom), M.zoomRange.lowerBound), M.zoomRange.upperBound)
                pan = CGPoint(x: bounds.midX - zoom * CGFloat(viewport.centerX), y: bounds.midY - zoom * CGFloat(viewport.centerY))
            } else {
                zoom = 1
                pan = CGPoint(x: bounds.midX - scene.bandFrame.midX, y: bounds.midY - scene.bandFrame.midY)
            }
        }
        applyTransform()
    }

    private static func add(_ edge: ElementOverviewScene.Edge, to path: CGMutablePath) {
        path.move(to: edge.from)
        path.addCurve(to: edge.to, control1: edge.control1, control2: edge.control2)
        if let (left, right) = edge.arrowBarbs {
            path.move(to: left); path.addLine(to: edge.to); path.addLine(to: right)
        }
    }

    private func isDragging(box key: String) -> Bool {
        if case .box(let dragged, _, _)? = gesture, dragged == key, moved { return true }
        return false
    }

    /// The layer of a card, for acceptance.
    func cardLayer(_ endpoint: RelationEndpoint) -> OverviewCardLayer? { cardLayers[endpoint.key] }
    func boxLayer(_ key: String) -> OverviewBoxLayer? { boxLayers[key] }
    var cardLayerCount: Int { cardLayers.count }

    // MARK: Selection and linking

    func select(edge id: String?) {
        selectedEdge = id
        render()
        controller?.updateEdgeBar()
    }

    /// The next card clicked becomes the other end of a new relation.
    func beginLink(from endpoint: RelationEndpoint) {
        linkSource = endpoint
        controller?.reload()
    }

    func cancelLink() {
        guard linkSource != nil else { return }
        linkSource = nil
        controller?.reload()
    }

    private func finishLink(to endpoint: RelationEndpoint) {
        guard let source = linkSource else { return }
        linkSource = nil
        controller?.reload()
        controller?.beginRelation(from: source, to: endpoint)
    }

    // MARK: Mouse

    private func endpoint(_ hit: ElementOverviewScene.Hit) -> RelationEndpoint? {
        guard case .card(let kind, let id) = hit else { return nil }
        return RelationEndpoint(kind: kind == .element ? "element" : "node", id: id)
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        let hit = model.scene.hit(worldPoint(view: point), tolerance: 6 / zoom)
        pressed = (hit, point, event.modifierFlags, event.clickCount)
        moved = false
        gesture = nil
    }

    override func mouseDragged(with event: NSEvent) {
        guard let pressed else { return }
        let point = convert(event.locationInWindow, from: nil)
        if !moved {
            guard hypot(point.x - pressed.point.x, point.y - pressed.point.y) >= 3 else { return }
            moved = true
            gesture = startGesture(pressed.target, at: pressed.point, flags: pressed.flags)
        }
        switch gesture {
        case .pan(let start, let origin)?:
            timed {
                pan = CGPoint(x: origin.x + point.x - start.x, y: origin.y + point.y - start.y)
                applyTransform()
            }
        case .box(let key, let start, let origin)?:
            timed {
                boxLayers[key]?.frame.origin = CGPoint(x: origin.x + (point.x - start.x) / zoom, y: origin.y + (point.y - start.y) / zoom)
                boxLayers[key]?.zPosition = 10
            }
        case .link(let from, _)?:
            timed {
                guard let card = model.scene.card(from) else { return }
                let path = CGMutablePath()
                path.move(to: CGPoint(x: card.frame.midX, y: card.frame.midY))
                path.addLine(to: worldPoint(view: point))
                linkLayer.path = path
                linkLayer.isHidden = false
            }
        case nil: break
        }
    }

    private func startGesture(_ hit: ElementOverviewScene.Hit, at point: CGPoint, flags: NSEvent.ModifierFlags) -> Gesture {
        if flags.contains(.option), let from = endpoint(hit) { return .link(from: from, start: point) }
        var key: String?
        switch hit {
        case .legend(let box), .box(let box): key = box
        case .card(.element, let id): key = model.scene.card(RelationEndpoint(kind: "element", id: id))?.boxKey
        default: key = nil
        }
        if let key, model.category(id: key) != nil, !model.busy, let layer = boxLayers[key] {
            return .box(key: key, start: point, origin: layer.frame.origin)
        }
        return .pan(start: point, origin: pan)
    }

    override func mouseUp(with event: NSEvent) {
        guard let pressed else { return }
        self.pressed = nil
        let point = convert(event.locationInWindow, from: nil)
        let gesture = self.gesture
        self.gesture = nil
        if moved {
            moved = false
            switch gesture {
            case .pan?: scheduleSharpen()
            case .box(let key, _, _)?:
                boxLayers[key]?.zPosition = 0
                let origin = boxLayers[key]?.frame.origin ?? .zero
                if let cell = model.scene.dropCell(key: key, origin: origin) {
                    model.pin(categoryID: key, cell: cell) { [weak self] _ in self?.render() }
                }
                // A drop that sent nothing lays the box back at once.
                if !model.busy { render() }
            case .link(let from, _)?:
                linkLayer.path = nil; linkLayer.isHidden = true
                let hit = model.scene.hit(worldPoint(view: point), tolerance: 0)
                if let to = endpoint(hit) { controller?.beginRelation(from: from, to: to) }
                else { controller?.showStatus("没有松开在卡片上，未新建关系。") }
            case nil: break
            }
            return
        }
        click(pressed.target, flags: pressed.flags, clicks: event.clickCount)
    }

    private func click(_ hit: ElementOverviewScene.Hit, flags: NSEvent.ModifierFlags, clicks: Int) {
        if let endpoint = endpoint(hit) {
            if linkSource != nil { finishLink(to: endpoint); return }
            if flags.contains(.shift) { beginLink(from: endpoint); return }
            switch hit {
            case .card(.element, _), .card(.drift, _): controller?.open(endpoint)
            case .card(.chapter, _): if clicks >= 2 { controller?.open(endpoint) }
            default: break
            }
            return
        }
        switch hit {
        case .legend(let key): controller?.openCategory(key: key)
        case .edge(let id): select(edge: id)
        default:
            if selectedEdge != nil { select(edge: nil) }
            cancelLink()
        }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        switch model.scene.hit(worldPoint(view: point), tolerance: 6 / zoom) {
        case .card(let kind, let id): return controller?.menu(for: .card(kind, id))
        case .legend(let key), .box(let key): return controller?.menu(for: .box(key))
        case .edge(let id):
            select(edge: id)
            return controller?.menu(for: .edge(id))
        default: return nil
        }
    }

    // MARK: Scroll, pinch and keys

    override func scrollWheel(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if event.modifierFlags.contains(.command) {
            let delta = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * 10
            zoom(by: exp(delta * 0.0015 * 4), around: point)
        } else {
            let scale: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 10
            pan(by: CGPoint(x: event.scrollingDeltaX * scale, y: event.scrollingDeltaY * scale))
        }
    }

    override func magnify(with event: NSEvent) {
        zoom(by: 1 + event.magnification, around: convert(event.locationInWindow, from: nil))
    }

    /// ⌘+ (or ⌘=), ⌘− and ⌘0; AppKit offers key equivalents to the key
    /// window's views, so they apply while the panel is key.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command), flags.isSubset(of: [.command, .shift]) else { return super.performKeyEquivalent(with: event) }
        switch event.charactersIgnoringModifiers {
        case "=", "+": zoom(by: 1.2); return true
        case "-", "−": zoom(by: 1 / 1.2); return true
        case "0": resetView(); return true
        default: return super.performKeyEquivalent(with: event)
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            if linkSource != nil { cancelLink() } else if selectedEdge != nil { select(edge: nil) }
            return
        }
        super.keyDown(with: event)
    }
}

// MARK: - Layers

/// A layer drawn with AppKit text in top-left coordinates, resolving
/// dynamic colours in the canvas's appearance.
class OverviewDrawnLayer: CALayer {
    weak var host: NSView?

    override init() {
        super.init()
        needsDisplayOnBoundsChange = true
        actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull()]
    }
    override init(layer: Any) { super.init(layer: layer) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(in ctx: CGContext) {
        ctx.saveGState()
        if !contentsAreFlipped() { ctx.translateBy(x: 0, y: bounds.height); ctx.scaleBy(x: 1, y: -1) }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
        if let appearance = host?.effectiveAppearance { appearance.performAsCurrentDrawingAppearance { drawContent() } }
        else { drawContent() }
        NSGraphicsContext.restoreGraphicsState()
        ctx.restoreGState()
    }

    func drawContent() {}

    static func paragraph(_ lineBreak: NSLineBreakMode, alignment: NSTextAlignment = .left) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = lineBreak
        style.alignment = alignment
        return style
    }
}

/// An element card, chapter pill or drift card: a wash with a border, the
/// title (an element's after a ◆ in its category's colour) and two lines
/// of summary.
final class OverviewCardLayer: OverviewDrawnLayer {
    struct Content: Equatable {
        let kind: ElementOverviewScene.Kind
        let title: String
        let detail: String
        let colorHex: String?
        let dimmed: Bool
        let linkSource: Bool
    }
    var content: Content? { didSet { if content != oldValue { setNeedsDisplay() } } }
    /// The card's frame in world points (its layer frame may be box-relative).
    var worldFrame = CGRect.zero

    override func drawContent() {
        guard let content else { return }
        let rect = bounds
        let tint = content.colorHex.flatMap(ElementSwatch.color(hex:))
        let accent = tint ?? .secondaryLabelColor
        let shape = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 3, yRadius: 3)
        switch content.kind {
        case .element:
            (content.linkSource ? NSColor.secondaryLabelColor.withAlphaComponent(0.12) : NSColor.textBackgroundColor).setFill()
            shape.fill()
            (content.linkSource ? accent : NSColor.separatorColor).setStroke()
        case .chapter:
            NSColor.textBackgroundColor.setFill(); shape.fill()
            accent.withAlphaComponent(content.linkSource ? 0.2 : 0.07).setFill(); shape.fill()
            accent.setStroke()
        case .drift:
            NSColor.textBackgroundColor.setFill(); shape.fill()
            NSColor.secondaryLabelColor.withAlphaComponent(content.linkSource ? 0.18 : 0.07).setFill(); shape.fill()
            NSColor.separatorColor.setStroke()
        }
        shape.lineWidth = 1
        shape.stroke()
        if content.linkSource {
            let outline = NSBezierPath(roundedRect: rect.insetBy(dx: 1.5, dy: 1.5), xRadius: 3, yRadius: 3)
            outline.setLineDash([4, 3], count: 2, phase: 0)
            outline.lineWidth = 1.5
            NSColor.labAccent.setStroke()
            outline.stroke()
        }
        let alpha: CGFloat = content.dimmed ? 0.5 : 1
        let title = NSMutableAttributedString()
        if content.kind == .element {
            title.append(NSAttributedString(string: "◆ ", attributes: [.font: NSFont.systemFont(ofSize: 9), .foregroundColor: accent]))
        }
        title.append(NSAttributedString(string: content.title, attributes: [
            .font: NSFont.systemFont(ofSize: content.kind == .element ? 11.5 : 11, weight: .medium),
            .foregroundColor: NSColor.labelColor.withAlphaComponent(alpha),
        ]))
        title.addAttribute(.paragraphStyle, value: Self.paragraph(.byTruncatingTail), range: NSRange(location: 0, length: title.length))
        let inset = rect.insetBy(dx: 7, dy: 5)
        let centred = content.detail.isEmpty
        let titleRect = CGRect(x: inset.minX, y: centred ? rect.midY - 8 : inset.minY, width: inset.width, height: 16)
        title.draw(with: titleRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        guard !content.detail.isEmpty else { return }
        let flat = content.detail.split(whereSeparator: \.isNewline).joined(separator: " ")
        let detail = NSAttributedString(string: flat, attributes: [
            .font: NSFont.systemFont(ofSize: 9.5), .foregroundColor: NSColor.secondaryLabelColor.withAlphaComponent(alpha),
            .paragraphStyle: Self.paragraph(.byWordWrapping),
        ])
        detail.draw(with: CGRect(x: inset.minX, y: inset.minY + 16, width: inset.width, height: max(0, inset.height - 16)),
                    options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
}

/// A small drawn label: a text with an optional detail after it and an
/// optional colour dot before it.
final class OverviewTextLayer: OverviewDrawnLayer {
    enum ColorRole: Equatable { case primary, secondary }
    struct Content: Equatable {
        var text: String
        var detail: String = ""
        var size: CGFloat
        var weight: NSFont.Weight
        var colorRole: ColorRole
        var dotHex: String? = nil
        var hollowDot = false
        var alignment: NSTextAlignment = .left
        var background = false
    }
    private(set) var content: Content?

    func show(_ content: Content, in host: NSView, scale: CGFloat) {
        self.host = host
        if contentsScale != scale { contentsScale = scale; setNeedsDisplay() }
        if self.content != content { self.content = content; setNeedsDisplay() }
        displayIfNeeded()
    }

    override func drawContent() {
        guard let content else { return }
        if content.background {
            NSColor.textBackgroundColor.setFill()
            NSBezierPath(rect: bounds).fill()
        }
        var x = bounds.minX + (content.background ? 6 : 0)
        let lineHeight = content.size + 5
        let y = content.alignment == .center ? bounds.midY - lineHeight / 2 : (content.background ? bounds.midY - lineHeight / 2 : bounds.minY)
        if content.dotHex != nil || content.hollowDot {
            let dot = NSBezierPath(roundedRect: CGRect(x: x, y: y + (lineHeight - 7) / 2, width: 7, height: 7), xRadius: 2, yRadius: 2)
            if let hex = content.dotHex, let color = ElementSwatch.color(hex: hex) { color.setFill(); dot.fill() }
            else { NSColor.tertiaryLabelColor.setStroke(); dot.stroke() }
            x += 12
        }
        let text = NSMutableAttributedString(string: content.text, attributes: [
            .font: NSFont.systemFont(ofSize: content.size, weight: content.weight),
            .foregroundColor: content.colorRole == .primary ? NSColor.labelColor : NSColor.secondaryLabelColor,
        ])
        if !content.detail.isEmpty {
            text.append(NSAttributedString(string: " · \(content.detail)", attributes: [
                .font: NSFont.systemFont(ofSize: content.size - 1), .foregroundColor: NSColor.tertiaryLabelColor,
            ]))
        }
        text.addAttribute(.paragraphStyle, value: Self.paragraph(.byTruncatingTail, alignment: content.alignment),
                          range: NSRange(location: 0, length: text.length))
        text.draw(with: CGRect(x: x, y: y, width: max(0, bounds.maxX - x - (content.background ? 6 : 0)), height: lineHeight),
                  options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
}

/// A category box: a border in the category's colour on paper, the legend
/// set into the top border, group headers and, when empty, a dashed 空 cell.
/// Its element cards are sublayers, so a dragged box carries them.
final class OverviewBoxLayer: CALayer {
    private let legend = OverviewTextLayer()
    private var headers: [OverviewTextLayer] = []
    private let placeholder = CAShapeLayer()
    private let placeholderText = OverviewTextLayer()
    private(set) var legendText = ""

    override init() {
        super.init()
        masksToBounds = false
        cornerRadius = 3
        addSublayer(placeholder)
        addSublayer(placeholderText)
        addSublayer(legend)
        legend.zPosition = 5
    }
    override init(layer: Any) { super.init(layer: layer) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func redrawText() {
        legend.setNeedsDisplay(); placeholderText.setNeedsDisplay()
        headers.forEach { $0.setNeedsDisplay() }
    }

    func show(_ box: ElementOverviewScene.Box, in host: NSView, scale: CGFloat, paper: CGColor, rule: CGColor) {
        let accent = box.model.category.flatMap { ElementSwatch.color(for: $0) } ?? .secondaryLabelColor
        var accentColor = accent.cgColor
        host.effectiveAppearance.performAsCurrentDrawingAppearance { accentColor = accent.cgColor }
        backgroundColor = paper
        borderColor = accentColor
        borderWidth = 1.5
        legendText = "\(box.model.name) ·\(box.model.count)"
        let legendWidth = min(box.frame.width - 16, (legendText as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 10.5, weight: .semibold)]).width + 36)
        legend.frame = CGRect(x: 8, y: -9, width: max(20, legendWidth), height: 18)
        legend.show(OverviewTextLayer.Content(text: box.model.name, detail: "\(box.model.count)", size: 10.5, weight: .semibold,
                                              colorRole: .primary, dotHex: box.model.category?.color, hollowDot: box.model.category == nil,
                                              background: true), in: host, scale: scale)
        let boxHeaders = box.headers
        while headers.count < boxHeaders.count { let header = OverviewTextLayer(); addSublayer(header); headers.append(header) }
        while headers.count > boxHeaders.count { headers.removeLast().removeFromSuperlayer() }
        for (layer, header) in zip(headers, boxHeaders) {
            layer.frame = header.frame.offsetBy(dx: -box.frame.minX, dy: -box.frame.minY)
            layer.show(OverviewTextLayer.Content(text: header.title, size: 9.5, weight: .medium, colorRole: .secondary), in: host, scale: scale)
        }
        let empty = box.model.count == 0
        placeholder.isHidden = !empty; placeholderText.isHidden = !empty
        if empty {
            let rect = CGRect(x: 3, y: 3, width: box.frame.width - 6, height: box.frame.height - 6)
            placeholder.path = CGPath(roundedRect: rect, cornerWidth: 2, cornerHeight: 2, transform: nil)
            placeholder.fillColor = nil
            placeholder.strokeColor = rule
            placeholder.lineDashPattern = [3, 3]
            placeholderText.frame = rect
            placeholderText.show(OverviewTextLayer.Content(text: "空", size: 10, weight: .regular, colorRole: .secondary, alignment: .center),
                                 in: host, scale: scale)
        }
    }
}

// MARK: - New relation sheet

/// 新建关系 from the canvas: the two ends (交换方向 swaps them), a type that
/// fits them from the author's types or one created inline, and 添加. Rust
/// validates every write; its refusals stay here.
final class OverviewRelationSheet: NSObject {
    let model: ElementOverviewModel
    let window: NSWindow
    let directionLabel = NSTextField(labelWithString: "")
    let swapButton = NSButton(title: "交换方向", target: nil, action: nil)
    let typePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let createTypeButton = NSButton(title: "新建关系类型…", target: nil, action: nil)
    let addButton = NSButton(title: "添加", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let message = NSTextField(wrappingLabelWithString: "")
    private(set) var from: RelationEndpoint
    private(set) var to: RelationEndpoint
    private(set) var typeID: String?
    private(set) var isSaving = false
    private(set) var typeEditor: RelationTypeEditorSheet?
    var onFinish: ((WorkspaceRelation?) -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    /// Author types that fit the ends in either direction.
    var typeOptions: [WorkspaceRelationType] { model.relations.library.types(between: from, and: to) }

    init(model: ElementOverviewModel, from: RelationEndpoint, to: RelationEndpoint) {
        self.model = model
        self.from = from
        self.to = to
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 220), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "新建关系"
        super.init()
        let title = NSTextField(labelWithString: "新建关系")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        let explanation = NSTextField(wrappingLabelWithString: "选择关系类型。只列出适用于这两端的关系类型；方向不对时可以交换两端。")
        explanation.textColor = .secondaryLabelColor
        directionLabel.lineBreakMode = .byTruncatingMiddle
        directionLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        directionLabel.setAccessibilityIdentifier("overview-relation-direction")
        swapButton.target = self; swapButton.action = #selector(swapDirection)
        swapButton.setAccessibilityIdentifier("overview-relation-swap")
        typePopup.target = self; typePopup.action = #selector(typeChosen)
        typePopup.setAccessibilityIdentifier("overview-relation-type")
        createTypeButton.target = self; createTypeButton.action = #selector(beginCreateType)
        createTypeButton.setAccessibilityIdentifier("overview-relation-create-type")
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("overview-relation-error")
        addButton.target = self; addButton.action = #selector(add)
        addButton.keyEquivalent = "\r"
        addButton.setAccessibilityIdentifier("confirm-overview-relation")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-overview-relation")
        let directionTitle = NSTextField(labelWithString: "方向"), typeTitle = NSTextField(labelWithString: "类型")
        directionTitle.textColor = .secondaryLabelColor; typeTitle.textColor = .secondaryLabelColor
        let directionRow = NSStackView(views: [directionTitle, directionLabel, swapButton, NSView()])
        let typeRow = NSStackView(views: [typeTitle, typePopup, createTypeButton])
        for row in [directionRow, typeRow] { row.spacing = 10 }
        typePopup.setContentHuggingPriority(.init(1), for: .horizontal)
        let buttons = NSStackView(views: [NSView(), cancelButton, addButton])
        let stack = NSStackView(views: [title, explanation, directionRow, typeRow, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 440),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            directionRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            typeRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            directionTitle.widthAnchor.constraint(equalTo: typeTitle.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        rebuild()
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    private func rebuild() {
        directionLabel.stringValue = "\(model.name(of: from)) → \(model.name(of: to))"
        let options = typeOptions
        if let typeID, !options.contains(where: { $0.id == typeID }) { self.typeID = nil }
        typePopup.removeAllItems()
        typePopup.menu?.addItem(NSMenuItem(title: options.isEmpty ? "没有适用的关系类型，可以新建" : "选择关系类型", action: nil, keyEquivalent: ""))
        for type in options {
            let item = NSMenuItem(title: "\(type.displayName)（\(type.summary)）", action: nil, keyEquivalent: "")
            item.representedObject = type.id
            item.setAccessibilityIdentifier("overview-relation-type-\(type.id)")
            typePopup.menu?.addItem(item)
        }
        let index = typePopup.itemArray.firstIndex { typeID != nil && $0.representedObject as? String == typeID }
        typePopup.selectItem(at: index ?? 0)
        swapButton.isEnabled = !isSaving && RelationKind.structural.contains(from.kind) && RelationKind.structural.contains(to.kind)
        typePopup.isEnabled = !isSaving
        createTypeButton.isEnabled = !isSaving
        validate()
    }

    /// A type that fits only the other way explains the swap Rust would ask for.
    private func validate() {
        guard let typeID, let type = model.relations.library.type(id: typeID) else { addButton.isEnabled = false; return }
        let check = type.check(from: from, to: to)
        if let refusal = check.message { showError(refusal) }
        addButton.isEnabled = check.isValid && !isSaving
    }

    /// Chooses a type, as the popup would.
    func chooseType(_ id: String) {
        guard let index = typePopup.itemArray.firstIndex(where: { $0.representedObject as? String == id }) else { return }
        typePopup.selectItem(at: index)
        typeChosen()
    }

    @objc private func typeChosen() {
        typeID = typePopup.selectedItem?.representedObject as? String
        showError(nil)
        validate()
    }

    @objc func swapDirection() {
        guard swapButton.isEnabled else { return }
        (from, to) = (to, from)
        showError(nil)
        rebuild()
    }

    @objc func beginCreateType() {
        guard typeEditor == nil else { return }
        let editor = RelationTypeEditorSheet(type: nil, sourceKinds: [from.kind], targetKinds: [to.kind])
        typeEditor = editor
        editor.onCancel = { [weak self] in self?.endTypeEditor() }
        editor.onSave = { [weak self] definition, done in
            guard let self else { return }
            if let refusal = definition.check(from: self.from, to: self.to).message { done(.failure(LabError.message(refusal))); return }
            self.model.relations.createType(definition) { [weak self] result in
                done(result)
                guard let self, case .success(let type) = result else { return }
                self.endTypeEditor()
                self.typeID = type.id
                self.showError(nil)
                self.rebuild()
            }
        }
        window.beginSheet(editor.window)
    }

    private func endTypeEditor() {
        guard let editor = typeEditor else { return }
        typeEditor = nil
        if let parent = editor.window.sheetParent { parent.endSheet(editor.window) } else { editor.window.orderOut(nil) }
    }

    func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    @objc func add() {
        guard let typeID, !isSaving, addButton.isEnabled else { return }
        showError(nil)
        isSaving = true; rebuild()
        model.addRelation(from: from, to: to, typeID: typeID) { [weak self] result in
            guard let self else { return }
            self.isSaving = false
            switch result {
            case .success(let relation): self.finish(relation)
            // The choice stays for another try.
            case .failure(let error): self.rebuild(); self.showError(error.localizedDescription)
            }
        }
    }

    @objc func cancel() { finish(nil) }

    private func finish(_ relation: WorkspaceRelation?) {
        endTypeEditor()
        onFinish?(relation)
    }
}
