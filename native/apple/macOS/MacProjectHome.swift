import AppKit

/// 今日 / 连续天数 / 本周 / 本月 from the 今日字数 ledger's days against the
/// 写作计划's daily goal. The streak counts consecutive days with positive
/// words ending today, or yesterday while nothing is written today yet.
/// Weeks start on Monday; the ledger keeps 31 days, a whole month.
struct ProjectHomeRhythm: Equatable {
    let today: Int
    let streak: Int
    let week: Int
    let month: Int
    /// Days of this month with positive words.
    let monthDays: Int
    let dailyGoal: Int
    let weekTarget: Int
    let monthTarget: Int

    init(days: [String: Int], now: Date, calendar: Calendar, plan: WritingPlan, dayKey: (Date) -> String) {
        let start = calendar.startOfDay(for: now)
        func words(_ date: Date) -> Int { days[dayKey(date)] ?? 0 }
        func day(_ offset: Int, from date: Date) -> Date { calendar.date(byAdding: .day, value: offset, to: date) ?? date }
        let todayWords = words(start)
        var streak = 0
        var cursor = todayWords > 0 ? start : day(-1, from: start)
        while words(cursor) > 0, streak < 400 { streak += 1; cursor = day(-1, from: cursor) }
        var mondays = calendar
        mondays.firstWeekday = 2
        /// The words of each day from the interval's start through today.
        func sum(_ interval: DateInterval?) -> (words: Int, written: Int) {
            guard let interval else { return (todayWords, todayWords > 0 ? 1 : 0) }
            var total = 0, written = 0, date = calendar.startOfDay(for: interval.start)
            while date <= start {
                let value = words(date)
                total += value
                if value > 0 { written += 1 }
                date = day(1, from: date)
            }
            return (total, written)
        }
        let monthSum = sum(calendar.dateInterval(of: .month, for: now))
        today = todayWords
        self.streak = streak
        week = sum(mondays.dateInterval(of: .weekOfYear, for: now)).words
        month = monthSum.words
        monthDays = monthSum.written
        dailyGoal = plan.dailyWordGoal
        weekTarget = plan.dailyWordGoal * 7
        monthTarget = plan.dailyWordGoal * (calendar.range(of: .day, in: .month, for: now)?.count ?? 30)
    }

    var todayText: String { DailyWordText.value(today: today, goal: dailyGoal) }
    var streakText: String { "\(streak) 天" }
    /// “3,200 / 10,500 字”, or “3,200 字” without a daily goal.
    var weekText: String {
        dailyGoal > 0 ? "\(WordCountText.grouped(week)) / \(WordCountText.full(weekTarget))" : WordCountText.full(week)
    }
    /// “12,000 / 46,500 字 · 写作 9 天”.
    var monthText: String {
        let words = dailyGoal > 0 ? "\(WordCountText.grouped(month)) / \(WordCountText.full(monthTarget))" : WordCountText.full(month)
        return "\(words) · 写作 \(monthDays) 天"
    }
}

/// A storyline with its chapters in book order.
struct ProjectHomeTrack {
    let storyline: WorkspaceStoryline
    let chapters: [WorkspaceChapter]
}

/// One line of 最近: a live page this device opened.
struct ProjectHomeRecent {
    let page: RecentPage
    let title: String
    let target: WorkspaceTabTarget

    var kindLabel: String {
        switch page.kind {
        case .chapter: return "章节"
        case .drift: return "漂流"
        case .element: return "设定"
        case .category: return "分类"
        case .storyline: return "故事线"
        }
    }
    var label: String { "\(kindLabel) · \(title)" }
}

/// 项目主页: one project's overview, read from the workspace (details,
/// chapters, node stamps, storylines, elements, drifts) and the tab host's
/// word counts, with 写作计划, 今日字数 and 最近 from `settings.json`. Reading
/// writes nothing. Library replies from anywhere reach it through the tab
/// host; a hidden page reads everything again when shown.
final class ProjectHomeModel {
    let projectID: String
    private(set) var projectName: String
    private let workspace: LabWorkspaceCore
    let settings: LabSettingsStore
    private(set) var details: WorkspaceProjectDetails?
    /// Live chapters in book order.
    private(set) var chapters: [WorkspaceChapter]?
    /// Every live chapter's and drift's stored stamp and status.
    private(set) var nodes: [WorkspaceNodeMetadata]?
    private(set) var storylines: WorkspaceStorylineLibrary?
    private(set) var elements: WorkspaceElementLibrary?
    private(set) var drifts: WorkspaceDriftLibrary?
    private(set) var counts: WordCountLibrary?
    /// The 继续写作 chapter's last paragraph, once read.
    private(set) var excerpt: (chapterID: String, text: String)?
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var loadError: String?
    /// Workspace reads sent, for acceptance.
    private(set) var reads = 0
    var onChange: (() -> Void)?
    /// Whether the page is on screen in a pane; stamps are read again only then.
    var isShown: () -> Bool = { true }
    /// The clock relative edit times follow.
    var now: () -> Date = Date.init
    /// Quiet time after counts change before stamps and the excerpt are read.
    static var stampDelay: TimeInterval = 0.4
    private var generation = 0
    private var stampRefresh: DispatchWorkItem?
    private var excerptRead: String?
    private var observers: [NSObjectProtocol] = []

    init(workspace: LabWorkspaceCore, settings: LabSettingsStore, project: WorkspaceProject) {
        self.workspace = workspace
        self.settings = settings
        projectID = project.id
        projectName = project.name
        let center = NotificationCenter.default
        for name in [LabSettingsStore.dailyWordsDidChange, LabSettingsStore.writingPlanDidChange, LabSettingsStore.recentPagesDidChange] {
            observers.append(center.addObserver(forName: name, object: settings, queue: .main) { [weak self] note in
                guard let self else { return }
                if let id = note.userInfo?["projectID"] as? String, id != self.projectID { return }
                self.onChange?()
            })
        }
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        stampRefresh?.cancel()
    }

    // MARK: Reading

    /// Reads everything again, one read after another on the workspace queue.
    func load(completion: (() -> Void)? = nil) {
        generation += 1
        let current = generation
        loading = true
        onChange?()
        reads += 6
        workspace.projectDetails(projectID: projectID) { [weak self] details in
            guard let self, current == self.generation else { return }
            self.workspace.chapters(projectID: self.projectID) { [weak self] chapters in
                guard let self, current == self.generation else { return }
                self.workspace.nodesMetadata(projectID: self.projectID) { [weak self] nodes in
                    guard let self, current == self.generation else { return }
                    self.workspace.storylineLibrary(projectID: self.projectID) { [weak self] storylines in
                        guard let self, current == self.generation else { return }
                        self.workspace.elementLibrary(projectID: self.projectID) { [weak self] elements in
                            guard let self, current == self.generation else { return }
                            self.workspace.driftLibrary(projectID: self.projectID) { [weak self] drifts in
                                guard let self, current == self.generation else { return }
                                var failure: Error?
                                func take<T>(_ result: Result<T, Error>) -> T? {
                                    switch result {
                                    case .success(let value): return value
                                    case .failure(let error): failure = failure ?? error; return nil
                                    }
                                }
                                if let value = take(details) { self.details = value; self.projectName = value.name }
                                if let value = take(chapters) { self.chapters = value }
                                if let value = take(nodes) { self.nodes = value }
                                if let value = take(storylines) { self.storylines = value }
                                if let value = take(elements) { self.elements = value }
                                if let value = take(drifts) { self.drifts = value }
                                self.loadError = failure?.localizedDescription
                                self.loading = false
                                self.loaded = true
                                self.excerptRead = nil
                                self.readExcerpt()
                                self.onChange?()
                                completion?()
                            }
                        }
                    }
                }
            }
        }
    }

    /// The stored summary, name and stamp again, e.g. after 编辑资料….
    func reloadDetails() {
        reads += 1
        workspace.projectDetails(projectID: projectID) { [weak self] result in
            guard let self, case .success(let details) = result else { return }
            self.details = details
            self.projectName = details.name
            self.onChange?()
        }
    }

    /// Saves stamp chapters and drifts: after counts change, the edit
    /// times and the 继续写作 chapter are read again while shown.
    private func scheduleStampRefresh() {
        stampRefresh?.cancel()
        let refresh = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.stampRefresh = nil
            guard self.isShown() else { return }
            self.reads += 1
            self.workspace.nodesMetadata(projectID: self.projectID) { [weak self] result in
                guard let self, case .success(let nodes) = result else { return }
                self.nodes = nodes
                self.readExcerpt()
                self.onChange?()
            }
        }
        stampRefresh = refresh
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stampDelay, execute: refresh)
    }

    /// The 继续写作 chapter's text, once per chapter and stamp.
    private func readExcerpt() {
        guard let chapter = continueChapter else { excerpt = nil; excerptRead = nil; return }
        let key = chapter.id + "|" + (stamp(chapter.id) ?? "")
        guard excerptRead != key else { return }
        excerptRead = key
        reads += 1
        workspace.agentReadProse(projectID: projectID, kind: "chapter", id: chapter.id) { [weak self] result in
            guard let self, self.excerptRead == key else { return }
            if case .success(let prose) = result { self.excerpt = (chapter.id, Self.lastParagraph(prose.text)) }
            self.onChange?()
        }
    }

    /// The last paragraph with text, at most 80 characters.
    static func lastParagraph(_ text: String) -> String {
        let paragraph = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty } ?? ""
        return paragraph.count > 80 ? String(paragraph.prefix(80)) + "…" : paragraph
    }

    // MARK: Following changes

    func rename(_ name: String) { projectName = name; onChange?() }

    func applyChapters(_ chapters: [WorkspaceChapter]) {
        self.chapters = chapters
        readExcerpt()
        onChange?()
    }

    func applyNodeMetadata(_ metadata: WorkspaceNodeMetadata) {
        if let index = nodes?.firstIndex(where: { $0.id == metadata.id }) { nodes?[index] = metadata }
        if metadata.kind == "chapter", let index = chapters?.firstIndex(where: { $0.id == metadata.id }), let old = chapters?[index] {
            chapters?[index] = WorkspaceChapter(id: old.id, title: metadata.title, writingStatus: metadata.writingStatus,
                                                bookOrder: old.bookOrder, updatedAt: metadata.updatedAt)
        }
        readExcerpt()
        onChange?()
    }

    func applyStorylines(_ library: WorkspaceStorylineLibrary) { storylines = library; onChange?() }
    func applyElements(_ library: WorkspaceElementLibrary) { elements = library; onChange?() }
    func applyDrifts(_ library: WorkspaceDriftLibrary) { drifts = library; onChange?() }

    func applyWordCounts(_ library: WordCountLibrary) {
        counts = library
        scheduleStampRefresh()
        onChange?()
    }

    // MARK: What the page shows

    var summary: String { details?.summary ?? "" }
    var storylineCount: Int? { storylines?.storylines.count }
    var chapterCount: Int? { chapters?.count }
    var elementCount: Int? { elements?.elements.count }

    /// The book's chapter words, 统计中… until every chapter is counted.
    var wordsText: String {
        guard let counts, let chapters else { return WordCountText.counting }
        let ids = chapters.map(\.id)
        guard let total = counts.total(chapterIDs: ids) else { return WordCountText.counting }
        return WordCountText.full(total)
    }

    private func stamp(_ nodeID: String) -> String? {
        nodes?.first { $0.id == nodeID }?.updatedAt ?? chapters?.first { $0.id == nodeID }?.updatedAt
    }

    /// The latest stamp of the project and its live chapters and drifts.
    var lastEdited: String? {
        let stamps = [details?.updatedAt].compactMap { $0 } + (nodes?.map(\.updatedAt) ?? [])
            + (chapters?.compactMap(\.updatedAt) ?? []) + (drifts?.drifts.map(\.updatedAt) ?? [])
        return stamps.max { (WorkspaceTrashText.date($0) ?? .distantPast) < (WorkspaceTrashText.date($1) ?? .distantPast) }
    }
    var lastEditedText: String { lastEdited.map { VersionHistoryTime.label($0, now: now()) } ?? "—" }

    /// The most recently edited live chapter; the later one in book order on a tie.
    var continueChapter: WorkspaceChapter? {
        guard let chapters, !chapters.isEmpty else { return nil }
        var best: (chapter: WorkspaceChapter, date: Date)?
        for chapter in chapters {
            let date = stamp(chapter.id).flatMap(WorkspaceTrashText.date) ?? .distantPast
            if best == nil || date >= best!.date { best = (chapter, date) }
        }
        return best?.chapter
    }
    var continueExcerpt: String? {
        guard let chapter = continueChapter, let excerpt, excerpt.chapterID == chapter.id else { return nil }
        return excerpt.text
    }

    func count(status: WritingStatus) -> Int { chapters?.filter { $0.writingStatus == status.rawValue }.count ?? 0 }
    /// “草稿 3 · 已完成 2 · 已弃用 1”, every status shown.
    var statusText: String {
        WritingStatus.chapter.map { "\($0.label) \(count(status: $0))" }.joined(separator: " · ")
    }
    /// Chapters 已完成 over all chapters, 0...1.
    var completion: Double {
        guard let chapters, !chapters.isEmpty else { return 0 }
        return Double(count(status: .finished)) / Double(chapters.count)
    }
    var completionText: String {
        "已完成 \(count(status: .finished)) / \(chapters?.count ?? 0) 章 · \(Int((completion * 100).rounded()))%"
    }

    var rhythm: ProjectHomeRhythm {
        ProjectHomeRhythm(days: settings.dailyWords(projectID: projectID), now: settings.now(), calendar: settings.calendar,
                          plan: settings.writingPlan(projectID: projectID), dayKey: settings.dayKey)
    }

    /// Each live storyline in authored order with its chapters in book order.
    var tracks: [ProjectHomeTrack] {
        guard let storylines else { return [] }
        let byID = Dictionary((chapters ?? []).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return storylines.storylines.map { storyline in
            ProjectHomeTrack(storyline: storyline, chapters: storylines.chapters(storylineID: storyline.id).compactMap { byID[$0.chapterId] })
        }
    }

    /// Live categories with their live elements, in library order.
    var categories: [(category: WorkspaceElementCategory, count: Int)] {
        guard let elements else { return [] }
        return elements.categories.map { category in (category, elements.elements.filter { $0.categoryId == category.id }.count) }
    }
    /// Live elements without a live category (未分类).
    var uncategorized: Int {
        guard let elements else { return 0 }
        let ids = Set(elements.categories.map(\.id))
        return elements.elements.filter { $0.categoryId.map { !ids.contains($0) } ?? true }.count
    }

    /// 最近: the stored pages that are live now, newest first; trashed and
    /// purged pages are left out.
    var recents: [ProjectHomeRecent] {
        settings.recentPages(projectID: projectID).compactMap { page -> ProjectHomeRecent? in
            switch page.kind {
            case .chapter:
                return chapters?.first { $0.id == page.id }.map { ProjectHomeRecent(page: page, title: $0.title, target: .chapter($0)) }
            case .drift:
                return drifts?.drift(id: page.id).map { ProjectHomeRecent(page: page, title: $0.title, target: .drift($0)) }
            case .element:
                return elements?.elements.first { $0.id == page.id }.map { ProjectHomeRecent(page: page, title: $0.name, target: .element($0)) }
            case .category:
                return elements?.categories.first { $0.id == page.id }.map { ProjectHomeRecent(page: page, title: $0.name, target: .category($0)) }
            case .storyline:
                return storylines?.storyline(id: page.id).map { ProjectHomeRecent(page: page, title: $0.name, target: .storyline($0)) }
            }
        }
    }
}

/// A chapter on a storyline track: a small square in its status's system
/// colour. Pressing it opens the chapter.
final class ChapterStatusChip: NSView {
    let chapter: WorkspaceChapter
    var onPress: (() -> Void)?
    static let side: CGFloat = 14

    static func color(status: String?) -> NSColor {
        switch status.flatMap(WritingStatus.init(rawValue:)) {
        case .draft?: return .systemBlue
        case .finished?: return .systemGreen
        case .discarded?: return .systemGray
        default: return .tertiaryLabelColor
        }
    }
    var color: NSColor { Self.color(status: chapter.writingStatus) }

    init(chapter: WorkspaceChapter, number: Int) {
        self.chapter = chapter
        super.init(frame: NSRect(x: 0, y: 0, width: Self.side, height: Self.side))
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: Self.side), heightAnchor.constraint(equalToConstant: Self.side)])
        let status = chapter.writingStatus.map(WritingStatus.label) ?? "未知状态"
        toolTip = "§\(number) \(chapter.title) · \(status)"
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("\(chapter.title)，\(status)")
        setAccessibilityIdentifier("home-track-chapter-\(chapter.id)")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        color.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 3, yRadius: 3).fill()
    }
    override func mouseDown(with event: NSEvent) { onPress?() }
    override func accessibilityPerformPress() -> Bool { onPress?(); return onPress != nil }
}

/// 项目主页 as a tab page: plain labels, buttons and a progress bar in one
/// scrolling column. Every section is laid out again when the model changes.
final class MacProjectHomeView: NSView {
    let model: ProjectHomeModel
    let nameLabel = NSTextField(wrappingLabelWithString: "")
    let summaryLabel = NSTextField(wrappingLabelWithString: "")
    let editProfileButton = NSButton(title: "编辑资料…", target: nil, action: nil)
    /// 故事线, 章节, 设定, 总字数 and 最后编辑, keyed storylines, chapters,
    /// elements, words and edited.
    private(set) var countValues: [String: NSTextField] = [:]
    let statusLabel = NSTextField(labelWithString: "")
    let progress = NSProgressIndicator()
    let progressLabel = NSTextField(labelWithString: "")
    let continueButton = NSButton(title: "", target: nil, action: nil)
    let continueExcerpt = NSTextField(wrappingLabelWithString: "")
    let continueMeta = NSTextField(labelWithString: "")
    /// 今日, 连续天数, 本周 and 本月, keyed today, streak, week and month.
    private(set) var rhythmValues: [String: NSTextField] = [:]
    private(set) var trackChips: [(storyline: WorkspaceStoryline, chips: [ChapterStatusChip])] = []
    private(set) var categoryButtons: [NSButton] = []
    let uncategorizedLabel = NSTextField(labelWithString: "")
    private(set) var recentButtons: [NSButton] = []
    let statusLine = NSTextField(wrappingLabelWithString: "")
    var onOpenChapter: ((WorkspaceChapter) -> Void)?
    var onOpenCategory: ((WorkspaceElementCategory) -> Void)?
    var onOpenRecent: ((ProjectHomeRecent) -> Void)?
    var onEditProfile: (() -> Void)?
    private let scroll = NSScrollView()
    private let column = NSStackView()
    private var actions: [ObjectIdentifier: () -> Void] = [:]

    init(model: ProjectHomeModel) {
        self.model = model
        super.init(frame: .zero)
        setAccessibilityIdentifier("project-home-\(model.projectID)")
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let document = HomeFlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document
        column.orientation = .vertical; column.alignment = .leading; column.spacing = 10
        column.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(column)
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor), scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            column.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 16),
            column.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -16),
            column.topAnchor.constraint(equalTo: document.topAnchor, constant: 12),
            column.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -16),
        ])
        nameLabel.font = .systemFont(ofSize: 22, weight: .semibold)
        nameLabel.setAccessibilityIdentifier("home-name")
        summaryLabel.textColor = .secondaryLabelColor
        summaryLabel.setAccessibilityIdentifier("home-summary")
        editProfileButton.target = self; editProfileButton.action = #selector(editProfile)
        editProfileButton.setAccessibilityIdentifier("home-edit-profile")
        statusLabel.setAccessibilityIdentifier("home-status")
        progress.isIndeterminate = false
        progress.style = .bar
        progress.minValue = 0; progress.maxValue = 1
        progress.setAccessibilityIdentifier("home-progress")
        progressLabel.textColor = .secondaryLabelColor
        progressLabel.setAccessibilityIdentifier("home-progress-text")
        continueButton.bezelStyle = .rounded
        continueButton.target = self; continueButton.action = #selector(openContinue)
        continueButton.setAccessibilityIdentifier("home-continue")
        continueExcerpt.textColor = .secondaryLabelColor
        continueExcerpt.setAccessibilityIdentifier("home-continue-excerpt")
        continueMeta.textColor = .secondaryLabelColor
        continueMeta.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        continueMeta.setAccessibilityIdentifier("home-continue-meta")
        uncategorizedLabel.textColor = .secondaryLabelColor
        uncategorizedLabel.setAccessibilityIdentifier("home-uncategorized")
        statusLine.textColor = .secondaryLabelColor
        statusLine.setAccessibilityIdentifier("home-status-line")
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: Layout

    /// Lays every section out again from the model.
    func reload() {
        column.arrangedSubviews.forEach { column.removeArrangedSubview($0); $0.removeFromSuperview() }
        actions.removeAll()
        nameLabel.stringValue = model.projectName
        summaryLabel.stringValue = model.summary.isEmpty ? "还没有简介。" : model.summary
        add(nameLabel, width: true)
        add(summaryLabel, width: true)
        add(editProfileButton)
        column.setCustomSpacing(18, after: editProfileButton)

        heading("概况")
        let counts: [(String, String, String)] = [
            ("storylines", "故事线", model.storylineCount.map(String.init) ?? "—"),
            ("chapters", "章节", model.chapterCount.map(String.init) ?? "—"),
            ("elements", "设定", model.elementCount.map(String.init) ?? "—"),
            ("words", "总字数", model.wordsText),
            ("edited", "最后编辑", model.lastEditedText),
        ]
        countValues = [:]
        add(grid(counts) { self.countValues[$0] = $1 })

        heading("章节状态")
        statusLabel.stringValue = model.statusText
        progress.doubleValue = model.completion
        progressLabel.stringValue = model.completionText
        add(statusLabel)
        add(progress, width: true)
        add(progressLabel)

        heading("继续写作")
        if let chapter = model.continueChapter {
            continueButton.title = chapter.title
            continueButton.isHidden = false
            continueExcerpt.stringValue = model.continueExcerpt ?? ""
            let stamp = model.nodes?.first { $0.id == chapter.id }?.updatedAt ?? chapter.updatedAt
            let words = model.counts?.count(nodeID: chapter.id).map(WordCountText.full)
            continueMeta.stringValue = [stamp.map { "最后编辑 " + VersionHistoryTime.label($0, now: model.now()) }, words]
                .compactMap { $0 }.joined(separator: " · ")
            add(continueButton)
            if !continueExcerpt.stringValue.isEmpty { add(continueExcerpt, width: true) }
            add(continueMeta)
        } else {
            continueButton.isHidden = true
            add(note(model.loaded ? "还没有章节。" : "正在读取…"))
        }

        heading("写作节奏")
        let rhythm = model.rhythm
        rhythmValues = [:]
        add(grid([("today", "今日", rhythm.todayText), ("streak", "连续天数", rhythm.streakText),
                  ("week", "本周", rhythm.weekText), ("month", "本月", rhythm.monthText)]) { self.rhythmValues[$0] = $1 })

        heading("故事线")
        trackChips = []
        let tracks = model.tracks
        if tracks.isEmpty { add(note(model.loaded ? "还没有故事线。" : "正在读取…")) }
        let numbers = Dictionary((model.chapters ?? []).enumerated().map { ($1.id, $0 + 1) }, uniquingKeysWith: { first, _ in first })
        for track in tracks {
            let name = NSTextField(labelWithString: track.storyline.name)
            name.lineBreakMode = .byTruncatingTail
            name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            name.widthAnchor.constraint(equalToConstant: 120).isActive = true
            name.setAccessibilityIdentifier("home-track-\(track.storyline.id)")
            let chips = track.chapters.map { chapter -> ChapterStatusChip in
                let chip = ChapterStatusChip(chapter: chapter, number: numbers[chapter.id] ?? 0)
                chip.onPress = { [weak self] in self?.onOpenChapter?(chapter) }
                return chip
            }
            trackChips.append((track.storyline, chips))
            let row = NSStackView(views: [name] + (chips.isEmpty ? [note("没有章节")] : chips))
            row.spacing = 4
            add(row)
        }
        if !tracks.isEmpty { add(legend()) }

        heading("设定分类")
        categoryButtons = model.categories.map { entry in
            let button = link("\(entry.category.name) · \(entry.count)", id: "home-category-\(entry.category.id)") { [weak self] in
                self?.onOpenCategory?(entry.category)
            }
            return button
        }
        categoryButtons.forEach { add($0) }
        uncategorizedLabel.stringValue = "未分类 · \(model.uncategorized)"
        if model.uncategorized > 0 { add(uncategorizedLabel) }
        if categoryButtons.isEmpty && model.uncategorized == 0 { add(note(model.loaded ? "还没有设定分类。" : "正在读取…")) }

        heading("最近")
        let recents = model.recents
        recentButtons = recents.enumerated().map { index, recent in
            link(recent.label, id: "home-recent-\(index)") { [weak self] in self?.onOpenRecent?(recent) }
        }
        recentButtons.forEach { add($0) }
        if recents.isEmpty { add(note("还没有在这台设备上打开过这个项目的页面。")) }

        statusLine.stringValue = model.loadError ?? ""
        if model.loadError != nil { add(statusLine, width: true) }
    }

    private func add(_ view: NSView, width: Bool = false) {
        column.addArrangedSubview(view)
        if width { view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true }
    }

    private func heading(_ text: String) {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        if let last = column.arrangedSubviews.last { column.setCustomSpacing(18, after: last) }
        add(label)
    }

    private func note(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.textColor = .secondaryLabelColor
        return label
    }

    private func grid(_ entries: [(String, String, String)], keep: (String, NSTextField) -> Void) -> NSGridView {
        let titles = entries.map { entry -> NSView in note(entry.1) }
        let values = entries.map { entry -> NSView in
            let value = NSTextField(labelWithString: entry.2)
            value.font = .systemFont(ofSize: 15, weight: .medium)
            value.setAccessibilityIdentifier("home-\(entry.0)")
            keep(entry.0, value)
            return value
        }
        let grid = NSGridView(views: [titles, values])
        grid.columnSpacing = 24; grid.rowSpacing = 2
        // Columns keep their content's width instead of sharing the page's.
        grid.setContentHuggingPriority(.required, for: .horizontal)
        return grid
    }

    private func legend() -> NSStackView {
        let items = WritingStatus.chapter.flatMap { status -> [NSView] in
            let swatch = ChapterStatusChip(chapter: WorkspaceChapter(id: "", title: status.label, writingStatus: status.rawValue), number: 0)
            swatch.setAccessibilityElement(false)
            swatch.toolTip = nil
            let label = note(status.label)
            label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            return [swatch, label]
        }
        let row = NSStackView(views: items)
        row.spacing = 4
        return row
    }

    private func link(_ title: String, id: String, action: @escaping () -> Void) -> NSButton {
        let button = NSButton(title: title, target: self, action: #selector(pressed(_:)))
        button.bezelStyle = .inline
        button.isBordered = false
        button.contentTintColor = .linkColor
        button.setAccessibilityIdentifier(id)
        actions[ObjectIdentifier(button)] = action
        return button
    }

    // MARK: Actions

    @objc private func pressed(_ sender: NSButton) { actions[ObjectIdentifier(sender)]?() }
    @objc func editProfile() { onEditProfile?() }
    @objc func openContinue() {
        guard let chapter = model.continueChapter else { return }
        onOpenChapter?(chapter)
    }
}

private final class HomeFlippedView: NSView {
    override var isFlipped: Bool { true }
}
