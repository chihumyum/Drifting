import AppKit

/// A thin progress track filled in the interface accent; no edge accent.
final class BookProgressBar: NSView {
    var fraction: Double = 0 { didSet { needsDisplay = true } }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 5) }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.secondaryLabelColor.withAlphaComponent(0.15).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 2, yRadius: 2).fill()
        guard fraction > 0 else { return }
        NSColor.labAccent.setFill()
        let width = max(2, bounds.width * CGFloat(min(1, fraction)))
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: width, height: bounds.height), xRadius: 2, yRadius: 2).fill()
    }
}

/// The acts' shares of the book as one strip of their colours.
final class BookActStrip: NSView {
    var rows: [BookStats.ActRow] = [] { didSet { needsDisplay = true } }
    /// The drawn segments' colours, in reading order.
    var colors: [NSColor] { rows.filter { $0.share > 0 }.map { BookRhythmChart.color(hex: $0.act.hex) } }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 6) }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.secondaryLabelColor.withAlphaComponent(0.15).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 2, yRadius: 2).fill()
        var x: CGFloat = 0
        for row in rows where row.share > 0 {
            let width = bounds.width * CGFloat(row.share)
            BookRhythmChart.color(hex: row.act.hex).setFill()
            NSRect(x: x, y: 0, width: width, height: bounds.height).fill()
            x += width
        }
    }
}

/// 章节长度节奏: one thin bar per chapter in reading order, as long as its
/// share of the longest chapter and coloured by its act (neutral before the
/// first act). Hovering names the chapter; a click selects it.
final class BookRhythmChart: NSView {
    static let rowHeight: CGFloat = 6
    static let barHeight: CGFloat = 3
    private(set) var bars: [BookStats.Bar] = []
    private var longest = 0
    private(set) var hovered: Int?
    private var tracking: NSTrackingArea?
    var onSelect: ((BookStats.Bar) -> Void)?
    var onHover: ((BookStats.Bar?) -> Void)?
    override var isFlipped: Bool { true }

    static func color(actIndex: Int?) -> NSColor {
        actIndex.flatMap { ElementSwatch.color(hex: BookPalette.act($0)) } ?? .tertiaryLabelColor
    }
    /// An act's colour (stored or by position); neutral before the first act.
    static func color(hex: String?) -> NSColor {
        hex.flatMap { ElementSwatch.color(hex: $0) } ?? .tertiaryLabelColor
    }

    func show(_ bars: [BookStats.Bar], longest: Int) {
        self.bars = bars
        self.longest = longest
        hovered = nil
        invalidateIntrinsicContentSize()
        needsDisplay = true
        setAccessibilityLabel("章节长度节奏，\(bars.count) 章")
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: CGFloat(bars.count) * Self.rowHeight + 2)
    }

    /// The whole row a bar sits in, for hit-testing.
    func rowRect(at index: Int) -> NSRect {
        NSRect(x: 0, y: CGFloat(index) * Self.rowHeight + 1, width: bounds.width, height: Self.rowHeight)
    }

    /// The drawn bar: at least a sliver, even for an empty chapter.
    func barRect(at index: Int) -> NSRect {
        let fraction = longest > 0 ? CGFloat(bars[index].words) / CGFloat(longest) : 0
        let row = rowRect(at: index)
        return NSRect(x: 0, y: row.minY + (Self.rowHeight - Self.barHeight) / 2, width: max(2, bounds.width * fraction), height: Self.barHeight)
    }

    func color(at index: Int) -> NSColor { Self.color(hex: bars[index].actHex) }

    func index(at point: NSPoint) -> Int? {
        let index = Int(floor((point.y - 1) / Self.rowHeight))
        return bars.indices.contains(index) ? index : nil
    }

    override func draw(_ dirtyRect: NSRect) {
        guard !bars.isEmpty else { return }
        let first = max(0, Int(floor((dirtyRect.minY - 1) / Self.rowHeight)))
        let last = min(bars.count - 1, Int(ceil((dirtyRect.maxY - 1) / Self.rowHeight)))
        guard first <= last else { return }
        for index in first...last {
            let alpha: CGFloat = hovered == nil ? 0.85 : (hovered == index ? 1 : 0.3)
            color(at: index).withAlphaComponent(alpha).setFill()
            NSBezierPath(roundedRect: barRect(at: index), xRadius: 1, yRadius: 1).fill()
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area); tracking = area
    }

    override func mouseMoved(with event: NSEvent) { hover(index(at: convert(event.locationInWindow, from: nil))) }
    override func mouseExited(with event: NSEvent) { hover(nil) }

    private func hover(_ index: Int?) {
        guard index != hovered else { return }
        hovered = index
        needsDisplay = true
        onHover?(index.map { bars[$0] })
    }

    override func mouseDown(with event: NSEvent) {
        guard let index = index(at: convert(event.locationInWindow, from: nil)) else { return }
        onSelect?(bars[index])
    }
}

/// 统计: the book overview (total, chapters, average, completion), the
/// writing plan's written/target progress, act rhythm with each act's words,
/// and chapter-length rhythm. Values come from the book layout, the word
/// count model and the plan; 统计中… stands until every chapter is counted.
final class MacBookStatsViewController: NSViewController {
    let model: WholeBookModel
    var counts: () -> WordCountLibrary? = { nil }
    var plan: () -> WritingPlan = { WritingPlan() }
    var onSelectChapter: ((BookChapter) -> Void)?
    var onSelectAct: ((BookAct) -> Void)?

    let totalValue = MacBookStatsViewController.value("book-stats-total")
    let chaptersValue = MacBookStatsViewController.value("book-stats-chapters")
    let averageValue = MacBookStatsViewController.value("book-stats-average")
    let completionValue = MacBookStatsViewController.value("book-stats-completion")
    let statusValue = MacBookStatsViewController.value("book-stats-statuses")
    let targetValue = MacBookStatsViewController.value("book-stats-target")
    let targetBar = BookProgressBar()
    let actStrip = BookActStrip()
    let actRows = NSStackView()
    let rhythm = BookRhythmChart()
    let caption = NSTextField(wrappingLabelWithString: "")
    private let actSection = NSStackView()
    private let rhythmSection = NSStackView()
    private let rhythmScroll = NSScrollView()
    private var rhythmHeight: NSLayoutConstraint!
    private(set) var stats: BookStats?

    init(model: WholeBookModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private static func value(_ identifier: String) -> NSTextField {
        let label = NSTextField(labelWithString: "")
        label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        label.alignment = .right
        label.setAccessibilityIdentifier(identifier)
        return label
    }

    private static func key(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 12)
        label.textColor = .secondaryLabelColor
        return label
    }

    private static func heading(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        return label
    }

    override func loadView() {
        let grid = NSGridView(views: [
            [Self.key("总字数"), totalValue], [Self.key("章节"), chaptersValue], [Self.key("平均每章"), averageValue],
            [Self.key("完成度"), completionValue], [Self.key("写作状态"), statusValue], [Self.key("已写 / 目标"), targetValue],
        ])
        grid.rowSpacing = 6
        grid.column(at: 1).xPlacement = .trailing
        targetBar.setAccessibilityIdentifier("book-stats-target-bar")
        actStrip.setAccessibilityIdentifier("book-stats-act-strip")
        actRows.orientation = .vertical; actRows.alignment = .leading; actRows.spacing = 2
        actSection.orientation = .vertical; actSection.alignment = .leading; actSection.spacing = 8
        for view in [Self.heading("幕节奏"), actStrip, actRows] { actSection.addArrangedSubview(view) }
        rhythm.setAccessibilityIdentifier("book-stats-rhythm")
        rhythm.onSelect = { [weak self] bar in self?.onSelectChapter?(bar.chapter) }
        rhythm.onHover = { [weak self] bar in self?.showCaption(bar) }
        rhythmScroll.documentView = rhythm
        rhythmScroll.hasVerticalScroller = true
        rhythmScroll.autohidesScrollers = true
        rhythmScroll.drawsBackground = false
        rhythmScroll.borderType = .noBorder
        rhythm.translatesAutoresizingMaskIntoConstraints = false
        caption.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        caption.textColor = .secondaryLabelColor
        caption.setAccessibilityIdentifier("book-stats-caption")
        rhythmSection.orientation = .vertical; rhythmSection.alignment = .leading; rhythmSection.spacing = 8
        for view in [Self.heading("章节长度节奏"), rhythmScroll, caption] { rhythmSection.addArrangedSubview(view) }
        let stack = NSStackView(views: [Self.heading("全书概览"), grid, targetBar, actSection, rhythmSection])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.setCustomSpacing(10, after: grid)
        // Sections are set apart by spacing and weight only.
        stack.setCustomSpacing(20, after: targetBar)
        stack.setCustomSpacing(20, after: actSection)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let root = NSView()
        root.addSubview(stack)
        rhythmHeight = rhythmScroll.heightAnchor.constraint(equalToConstant: 40)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16),
            root.widthAnchor.constraint(equalToConstant: 360),
            grid.widthAnchor.constraint(equalTo: stack.widthAnchor),
            targetBar.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actSection.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actStrip.widthAnchor.constraint(equalTo: actSection.widthAnchor),
            actRows.widthAnchor.constraint(equalTo: actSection.widthAnchor),
            rhythmSection.widthAnchor.constraint(equalTo: stack.widthAnchor),
            rhythmScroll.widthAnchor.constraint(equalTo: rhythmSection.widthAnchor), rhythmHeight,
            rhythm.leadingAnchor.constraint(equalTo: rhythmScroll.contentView.leadingAnchor),
            rhythm.topAnchor.constraint(equalTo: rhythmScroll.contentView.topAnchor),
            rhythm.widthAnchor.constraint(equalTo: rhythmScroll.contentView.widthAnchor),
            caption.widthAnchor.constraint(equalTo: rhythmSection.widthAnchor),
        ])
        view = root
        model.observe(self) { [weak self] in self?.reload() }
        NotificationCenter.default.addObserver(self, selector: #selector(planChanged(_:)), name: LabSettingsStore.writingPlanDidChange, object: nil)
        reload()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func planChanged(_ notification: Notification) {
        if notification.userInfo?["projectID"] as? String == model.projectID { reload() }
    }

    /// Recomputes every value from the current book, counts and plan.
    func reload() {
        guard isViewLoaded else { return }
        guard model.loaded else {
            for label in [totalValue, averageValue, targetValue] { label.stringValue = WordCountText.counting }
            chaptersValue.stringValue = "—"; completionValue.stringValue = "—"; statusValue.stringValue = "—"
            targetBar.isHidden = true; actSection.isHidden = true; rhythmSection.isHidden = true
            return
        }
        let stats = BookStats(layout: model.layout, counts: counts(), plan: plan())
        self.stats = stats
        totalValue.stringValue = stats.totalText
        chaptersValue.stringValue = stats.chaptersText
        averageValue.stringValue = stats.averageText
        completionValue.stringValue = "\(stats.completionText) · \(stats.completionDetail)"
        statusValue.stringValue = stats.statusText
        targetValue.stringValue = stats.targetText
        targetBar.fraction = stats.ready ? (stats.targetFraction ?? 0) : 0
        targetBar.isHidden = !stats.ready || stats.targetFraction == nil
        // Rhythm reads only once every chapter is counted.
        actSection.isHidden = !stats.ready || stats.acts.isEmpty
        rhythmSection.isHidden = !stats.ready || stats.bars.isEmpty
        actStrip.rows = stats.acts
        for child in actRows.arrangedSubviews { actRows.removeArrangedSubview(child); child.removeFromSuperview() }
        for row in stats.acts { actRows.addArrangedSubview(actButton(row)) }
        rhythm.show(stats.bars, longest: stats.longestWords)
        rhythmHeight.constant = min(240, max(20, rhythm.intrinsicContentSize.height))
        showCaption(nil)
        // A popover takes this size.
        view.layoutSubtreeIfNeeded()
        preferredContentSize = view.fittingSize
    }

    /// An act row: its colour, name, chapters, words and share; a click
    /// scrolls the long page to the act.
    private func actButton(_ row: BookStats.ActRow) -> NSButton {
        let button = BookStatsActButton(title: "", target: nil, action: nil)
        button.act = row.act
        button.isBordered = false
        button.imagePosition = .imageLeading
        button.image = ElementSwatch.image(color: BookRhythmChart.color(hex: row.act.hex))
        let title = NSMutableAttributedString(string: row.act.title, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium)])
        title.append(NSAttributedString(string: "  " + BookStats.actText(row), attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor]))
        button.attributedTitle = title
        button.toolTip = "跳到\(row.act.title)"
        button.target = self; button.action = #selector(actChosen(_:))
        button.setAccessibilityIdentifier("book-stats-act-\(row.act.id)")
        button.setAccessibilityLabel("\(row.act.title)，\(BookStats.actText(row))")
        return button
    }

    @objc private func actChosen(_ sender: BookStatsActButton) {
        if let act = sender.act { onSelectAct?(act) }
    }

    /// The hovered chapter, else the longest and shortest.
    private func showCaption(_ bar: BookStats.Bar?) {
        if let bar { caption.stringValue = BookStats.barText(bar); return }
        guard let stats, let extremes = stats.extremes else { caption.stringValue = ""; return }
        var lines = ["最长：\(BookStats.barText(extremes.longest))"]
        if extremes.shortest.chapter.id != extremes.longest.chapter.id { lines.append("最短：\(BookStats.barText(extremes.shortest))") }
        caption.stringValue = lines.joined(separator: "\n")
    }
}

final class BookStatsActButton: NSButton {
    var act: BookAct?
}
