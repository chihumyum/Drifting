import AppKit
import CoreText

/// Editor preferences the body editors read. Until 设置 applies they stay
/// nil and editors keep the text system's defaults.
enum MacEditorPreferences {
    static let didChange = Notification.Name("MacEditorPreferencesDidChange")
    /// Continuous spell checking in every body editor.
    static var spellChecking: Bool? { didSet { if spellChecking != oldValue { post() } } }
    /// The chosen 界面强调色; nil follows the system accent colour.
    static var accentColor: NSColor? { didSet { if accentColor != oldValue { post() } } }
    /// 打字机滚动: typing keeps the caret line at a fixed height in every body.
    static var typewriterScrolling: Bool? { didSet { if typewriterScrolling != oldValue { post() } } }
    /// 打字机位置: where that line sits, as a share of the visible height
    /// from the top; nil is 40%.
    static var typewriterPosition: CGFloat? { didSet { if typewriterPosition != oldValue { post() } } }
    /// 版心宽度: the widest the prose column of a body editor and the 全书长卷
    /// grows, in points; nil fills the pane (the headless default).
    static var columnWidth: CGFloat? { didSet { if columnWidth != oldValue { post() } } }
    private static func post() { NotificationCenter.default.post(name: didChange, object: nil) }
}

extension NSColor {
    /// The 界面强调色 chosen in 设置, else the system accent colour. Washes
    /// and highlights draw with it; the insertion point never does.
    static var labAccent: NSColor { MacEditorPreferences.accentColor ?? .controlAccentColor }
}

/// What 设置 stores: appearance, editor typesetting and language. Values are
/// clamped on read, so a hand-edited or older file still opens.
/// A run of consecutive days with positive words, `days` long, whose last
/// day `through` (`yyyy-MM-dd`) is no longer kept in the daily ledger.
struct DailyStreakCarry: Codable, Equatable {
    var through: String
    var days: Int
}

struct LabSettings: Codable, Equatable {
    enum Theme: String, Codable, CaseIterable { case light, dark, system }
    enum FontSource: String, Codable, CaseIterable { case systemSerif, systemSans, systemMono, systemCustom, imported }
    enum Indent: String, Codable, CaseIterable { case none, one, two }
    /// The one imported font: its copy is `fonts/<storedName>` in the lab
    /// data directory.
    struct ImportedFont: Codable, Equatable {
        var fileName: String
        var storedName: String
        var family: String
        var byteLength: Int
    }

    var theme: Theme = .system
    /// `#RRGGBB`; nil follows the system accent colour.
    var accentColor: String?
    var fontSource: FontSource = .systemSerif
    var systemFontFamily = ""
    var importedFont: ImportedFont?
    var fontSize: Double = 17
    var lineHeight: Double = 1.5
    var paragraphIndent: Indent = .none
    var spellcheck = true
    var manuscriptLocale = "zh-CN"
    /// 打字机滚动 (off by default): the caret line stays at 打字机位置.
    var typewriterScrolling = false
    /// 打字机位置: the caret line's height with 打字机滚动, in percent of the
    /// visible prose from the top (25–75, default 40).
    var typewriterPosition: Double = 40
    /// 段间距: space after each paragraph, in em of the body size (0–2.5;
    /// 0.7 is the earlier 12 pt at 17 pt).
    var paragraphSpacing: Double = 0.7
    /// 版心宽度: the widest the prose column grows, in points (480–1280;
    /// 760 is the 全书长卷's earlier column).
    var columnWidth: Double = 760
    /// 自动链接设定名称: while on, settled typing links element names,
    /// aliases and chapter titles; off adds no new links, existing ones stay.
    var autoEntityLinks = true
    /// The list filter of each storyline or category page, per project and
    /// page (`storyline:<id>`, `category:<id>`); 全部 has no entry.
    var listFilters: [String: [String: String]] = [:]
    /// 全书长卷: each project's reading position.
    var wholeBookPositions: [String: WholeBookPosition] = [:]
    /// Each project's 写作计划, keyed by project identity; a project without
    /// one uses the defaults.
    var writingPlans: [String: WritingPlan] = [:]
    /// Each project's 设定总览 viewport, keyed by project identity.
    var elementOverviewViewports: [String: ElementOverviewViewport] = [:]
    /// 今日字数: per project, the net change in canonical chapter word
    /// counts this device's own saves made on each local calendar day
    /// (`yyyy-MM-dd`), for the last 31 days. See `DailyWordLedger`.
    var dailyWords: [String: [String: Int]] = [:]
    /// Each project's 底部时间轴: shown or hidden, and 阅读顺序 or 故事时间.
    var bottomTimelines: [String: BottomTimelineSetting] = [:]
    /// Each chapter's or drift's 情节规划格 dock: shown or hidden and its
    /// height, keyed by project identity, then node identity.
    var plotPlanners: [String: [String: PlotPlannerSetting]] = [:]
    /// 设置 › Copilot（实验）: off by default.
    var copilot = CopilotSettings()
    /// 设置 › 写作助手 › MCP 扩展: each project's servers, keyed by project
    /// identity. Secret values are in the Keychain, never here.
    var mcpServers: [String: [AgentMcpServerConfig]] = [:]
    /// 设置 › 快捷键: menu commands whose shortcut the author changed, keyed
    /// by command identifier (`file.print`); an empty key removes the
    /// default. Commands without an entry keep their default.
    var shortcuts: [String: MenuShortcut] = [:]
    /// 项目主页 › 连续天数 beyond the kept days: per project, the run of
    /// consecutive days with positive words that ended on the newest day
    /// already dropped from `dailyWords` (none when that run broke).
    var dailyStreaks: [String: DailyStreakCarry] = [:]
    /// 项目主页 › 最近: per project, the last pages this device opened,
    /// newest first (identities only; titles are read live).
    var recentPages: [String: [RecentPage]] = [:]
    /// Per project, the tabs of both panes in order, each pane's shown tab
    /// and whether the split is shown, restored when the project opens.
    var tabSessions: [String: TabSession] = [:]
    /// The project selected last; it opens with its tabs at launch.
    var lastProject: String?
    /// 视图 › 大纲轨道 per page kind (`chapter`, `drift`, `element`,
    /// `storyline`, `category`); a kind without an entry shows it.
    var outlineRails: [String: Bool] = [:]
    /// 便笺栏: per project and page (`node:<id>`, `element:<id>`,
    /// `category:<id>`, `storyline:<id>`), the notes and TODOs pinned to its
    /// margin, oldest first, and whether they are spread out.
    var stickyNotes: [String: [String: StickyNotePage]] = [:]

    static let fontSizes: ClosedRange<Double> = 12...28
    static let lineHeights: ClosedRange<Double> = 1.0...2.0
    static let paragraphSpacings: ClosedRange<Double> = 0...2.5
    static let columnWidths: ClosedRange<Double> = 480...1280
    static let typewriterPositions: ClosedRange<Double> = 25...75
    /// The page kinds with a 大纲轨道.
    static let railKinds: Set<String> = ["chapter", "drift", "element", "storyline", "category"]
    static let locales: [(code: String, name: String)] = [
        ("zh-CN", "中文（简体）"), ("zh-TW", "中文（繁體）"), ("en", "English"), ("ja", "日本語"), ("ko", "한국어"), ("fr", "Français"),
    ]

    init() {}

    private enum CodingKeys: String, CodingKey {
        case theme, accentColor, fontSource, systemFontFamily, importedFont, fontSize, lineHeight, paragraphIndent, spellcheck, manuscriptLocale
        case typewriterScrolling, typewriterPosition, paragraphSpacing, columnWidth, autoEntityLinks, listFilters, wholeBookPositions
        case writingPlans, elementOverviewViewports, dailyWords, bottomTimelines, plotPlanners, copilot, mcpServers, shortcuts
        case recentPages, dailyStreaks, tabSessions, lastProject, outlineRails, stickyNotes
    }

    /// Unknown or damaged values fall back to their defaults one by one.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        theme = (try? values.decodeIfPresent(Theme.self, forKey: .theme)) ?? .system
        accentColor = (try? values.decodeIfPresent(String.self, forKey: .accentColor)) ?? nil
        fontSource = (try? values.decodeIfPresent(FontSource.self, forKey: .fontSource)) ?? .systemSerif
        systemFontFamily = (try? values.decodeIfPresent(String.self, forKey: .systemFontFamily)) ?? ""
        importedFont = (try? values.decodeIfPresent(ImportedFont.self, forKey: .importedFont)) ?? nil
        fontSize = (try? values.decodeIfPresent(Double.self, forKey: .fontSize)) ?? 17
        lineHeight = (try? values.decodeIfPresent(Double.self, forKey: .lineHeight)) ?? 1.5
        paragraphIndent = (try? values.decodeIfPresent(Indent.self, forKey: .paragraphIndent)) ?? .none
        spellcheck = (try? values.decodeIfPresent(Bool.self, forKey: .spellcheck)) ?? true
        manuscriptLocale = (try? values.decodeIfPresent(String.self, forKey: .manuscriptLocale)) ?? "zh-CN"
        typewriterScrolling = (try? values.decodeIfPresent(Bool.self, forKey: .typewriterScrolling)) ?? false
        typewriterPosition = (try? values.decodeIfPresent(Double.self, forKey: .typewriterPosition)) ?? 40
        paragraphSpacing = (try? values.decodeIfPresent(Double.self, forKey: .paragraphSpacing)) ?? 0.7
        columnWidth = (try? values.decodeIfPresent(Double.self, forKey: .columnWidth)) ?? 760
        autoEntityLinks = (try? values.decodeIfPresent(Bool.self, forKey: .autoEntityLinks)) ?? true
        // One unreadable project or page drops alone.
        let filterValues = (try? values.decodeIfPresent([String: LenientFilters].self, forKey: .listFilters)) ?? [:]
        listFilters = filterValues.mapValues(\.value).filter { !$0.value.isEmpty }
        let positionValues = (try? values.decodeIfPresent([String: LenientPosition].self, forKey: .wholeBookPositions)) ?? [:]
        wholeBookPositions = positionValues.compactMapValues(\.value)
        writingPlans = (try? values.decodeIfPresent([String: WritingPlan].self, forKey: .writingPlans)) ?? [:]
        elementOverviewViewports = (try? values.decodeIfPresent([String: ElementOverviewViewport].self,
                                                                forKey: .elementOverviewViewports)) ?? [:]
        dailyWords = (try? values.decodeIfPresent([String: [String: Int]].self, forKey: .dailyWords)) ?? [:]
        dailyStreaks = (try? values.decodeIfPresent([String: DailyStreakCarry].self, forKey: .dailyStreaks)) ?? [:]
        bottomTimelines = (try? values.decodeIfPresent([String: BottomTimelineSetting].self, forKey: .bottomTimelines)) ?? [:]
        plotPlanners = (try? values.decodeIfPresent([String: [String: PlotPlannerSetting]].self, forKey: .plotPlanners)) ?? [:]
        copilot = (try? values.decodeIfPresent(CopilotSettings.self, forKey: .copilot)) ?? CopilotSettings()
        mcpServers = (try? values.decodeIfPresent([String: [AgentMcpServerConfig]].self, forKey: .mcpServers)) ?? [:]
        // One unreadable shortcut does not take the others with it.
        let shortcutValues = (try? values.decodeIfPresent([String: LenientShortcut].self, forKey: .shortcuts)) ?? [:]
        shortcuts = shortcutValues.compactMapValues(\.value)
        // An unreadable entry drops alone; the list keeps its order.
        let recentValues = (try? values.decodeIfPresent([String: [LenientRecentPage]].self, forKey: .recentPages)) ?? [:]
        recentPages = recentValues.mapValues { $0.compactMap(\.value) }.filter { !$0.value.isEmpty }
        // One project's unreadable tabs do not take the others with them.
        let sessionValues = (try? values.decodeIfPresent([String: LenientTabSession].self, forKey: .tabSessions)) ?? [:]
        tabSessions = sessionValues.compactMapValues(\.value).filter { !$0.value.isEmpty }
        lastProject = (try? values.decodeIfPresent(String.self, forKey: .lastProject)) ?? nil
        outlineRails = (try? values.decodeIfPresent([String: Bool].self, forKey: .outlineRails)) ?? [:]
        // One unreadable page drops alone.
        let stickyValues = (try? values.decodeIfPresent([String: [String: LenientStickyPage]].self, forKey: .stickyNotes)) ?? [:]
        stickyNotes = stickyValues.mapValues { $0.compactMapValues(\.value) }
        self = normalized()
    }

    func normalized() -> LabSettings {
        var next = self
        next.fontSize = min(max(fontSize.isFinite ? fontSize.rounded() : 17, Self.fontSizes.lowerBound), Self.fontSizes.upperBound)
        next.lineHeight = min(max(lineHeight.isFinite ? (lineHeight * 100).rounded() / 100 : 1.5, Self.lineHeights.lowerBound),
                              Self.lineHeights.upperBound)
        next.systemFontFamily = String(systemFontFamily.trimmingCharacters(in: .whitespacesAndNewlines).prefix(128))
        next.paragraphSpacing = Self.clamped(paragraphSpacing, Self.paragraphSpacings, step: 0.1, fallback: 0.7)
        next.columnWidth = Self.clamped(columnWidth, Self.columnWidths, step: 10, fallback: 760)
        next.typewriterPosition = Self.clamped(typewriterPosition, Self.typewriterPositions, step: 1, fallback: 40)
        next.listFilters = listFilters.mapValues { $0.filter { ListFilter.known($0.value) && $0.value != ListFilter.all } }
            .filter { !$0.value.isEmpty }
        if let accent = accentColor, DocumentStyle.linkColor(hex: accent) == nil { next.accentColor = nil }
        if !Self.locales.contains(where: { $0.code == manuscriptLocale }) { next.manuscriptLocale = "zh-CN" }
        if next.fontSource == .systemCustom, next.systemFontFamily.isEmpty { next.fontSource = .systemSerif }
        if next.fontSource == .imported, next.importedFont == nil { next.fontSource = .systemSerif }
        next.copilot = copilot.normalized()
        // A shortcut no command may take (no ⌘ or ⌃, or reserved by the
        // system) is dropped; the command keeps its default.
        next.shortcuts = shortcuts.filter { MacShortcuts.refusal($0.value) == nil }
        next.outlineRails = outlineRails.filter { Self.railKinds.contains($0.key) && !$0.value }
        next.stickyNotes = stickyNotes.mapValues { $0.mapValues { $0.normalized() }.filter { !$0.value.pinned.isEmpty } }
            .filter { !$0.value.isEmpty }
        return next
    }

    /// A finite value rounded to `step` inside `range`; anything else is `fallback`.
    static func clamped(_ value: Double, _ range: ClosedRange<Double>, step: Double, fallback: Double) -> Double {
        guard value.isFinite else { return fallback }
        let rounded = (value / step).rounded() * step
        // Keep one decimal exact (0.7, not 0.7000000000000001).
        let tidy = (rounded * 1000).rounded() / 1000
        return min(max(tidy, range.lowerBound), range.upperBound)
    }

    private struct LenientFilters: Decodable {
        let value: [String: String]
        init(from decoder: Decoder) throws {
            let raw = (try? [String: LenientString](from: decoder)) ?? [:]
            value = raw.compactMapValues(\.value)
        }
    }
    private struct LenientString: Decodable {
        let value: String?
        init(from decoder: Decoder) throws { value = try? String(from: decoder) }
    }
    private struct LenientPosition: Decodable {
        let value: WholeBookPosition?
        init(from decoder: Decoder) throws { value = try? WholeBookPosition(from: decoder) }
    }

    private struct LenientShortcut: Decodable {
        let value: MenuShortcut?
        init(from decoder: Decoder) throws { value = try? MenuShortcut(from: decoder) }
    }
    private struct LenientRecentPage: Decodable {
        let value: RecentPage?
        init(from decoder: Decoder) throws { value = try? RecentPage(from: decoder) }
    }
    private struct LenientStickyPage: Decodable {
        let value: StickyNotePage?
        init(from decoder: Decoder) throws { value = try? StickyNotePage(from: decoder) }
    }
    private struct LenientTabSession: Decodable {
        let value: TabSession?
        init(from decoder: Decoder) throws { value = try? TabSession(from: decoder) }
    }

    /// The manuscript language as a BCP 47 tag for CoreText.
    var languageTag: String {
        switch manuscriptLocale {
        case "zh-CN": return "zh-Hans"
        case "zh-TW": return "zh-Hant"
        default: return manuscriptLocale
        }
    }
}

/// Where the 全书长卷 was read: the row at the top of the viewport
/// (`chapter:<id>` or `act:<id>`) and how far into it the top is, in points.
struct WholeBookPosition: Codable, Equatable {
    var row: String
    var offset: Double

    private enum CodingKeys: String, CodingKey { case row, offset }
    init(row: String, offset: Double) { self.row = row; self.offset = offset }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        row = try values.decode(String.self, forKey: .row)
        let offset = try values.decode(Double.self, forKey: .offset)
        guard row.hasPrefix("chapter:") || row.hasPrefix("act:"), offset.isFinite else {
            throw DecodingError.dataCorruptedError(forKey: .row, in: values, debugDescription: "Unknown 全书长卷 position")
        }
        self.offset = min(max(offset, -10_000), 10_000_000)
    }
}

/// A page's 便笺栏: the comments pinned to it, oldest first (each once),
/// and whether the cards are spread out (else stacked).
struct StickyNotePage: Codable, Equatable {
    var pinned: [String] = []
    var expanded = false

    init(pinned: [String] = [], expanded: Bool = false) { self.pinned = pinned; self.expanded = expanded }
    private enum CodingKeys: String, CodingKey { case pinned, expanded }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        pinned = try values.decode([String].self, forKey: .pinned)
        expanded = (try? values.decodeIfPresent(Bool.self, forKey: .expanded)) ?? false
        self = normalized()
    }
    func normalized() -> StickyNotePage {
        var seen = Set<String>()
        return StickyNotePage(pinned: pinned.filter { !$0.isEmpty && seen.insert($0).inserted }, expanded: expanded)
    }
}

/// The filters of a storyline page's chapters (全部, 已写, 未起) and a
/// category page's elements (全部, 已填写, 未填写), as `settings.json` keeps them.
enum ListFilter {
    static let all = "all"
    static let written = "written", unwritten = "unwritten"
    static let filled = "filled", unfilled = "unfilled"
    static func known(_ value: String) -> Bool { [all, written, unwritten, filled, unfilled].contains(value) }
}

/// A page this device opened, for 项目主页 › 最近: a chapter, drift,
/// element, category or storyline, by identity.
struct RecentPage: Codable, Hashable {
    enum Kind: String, Codable, CaseIterable { case chapter, drift, element, category, storyline }
    let kind: Kind
    let id: String
}

/// A project's tabs as they were left: each pane's body tabs in order (by
/// identity; titles are read live), the one it showed and whether it had,
/// and showed, the project's 项目主页. Two panes mean the split was shown.
/// Read leniently: an unreadable tab drops alone, an unknown shown tab is
/// forgotten and more than two panes keep the first two.
struct TabSession: Codable, Equatable {
    struct Pane: Codable, Equatable {
        var tabs: [RecentPage] = []
        var active: RecentPage?
        var home = false
        var homeShown = false

        init(tabs: [RecentPage] = [], active: RecentPage? = nil, home: Bool = false, homeShown: Bool = false) {
            self.tabs = tabs; self.active = active; self.home = home; self.homeShown = homeShown
        }
        private enum CodingKeys: String, CodingKey { case tabs, active, home, homeShown }
        private struct LenientPage: Decodable {
            let value: RecentPage?
            init(from decoder: Decoder) throws { value = try? RecentPage(from: decoder) }
        }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            tabs = ((try? values.decodeIfPresent([LenientPage].self, forKey: .tabs)) ?? []).compactMap(\.value)
            active = (try? values.decodeIfPresent(RecentPage.self, forKey: .active)) ?? nil
            home = (try? values.decodeIfPresent(Bool.self, forKey: .home)) ?? false
            homeShown = (try? values.decodeIfPresent(Bool.self, forKey: .homeShown)) ?? false
            self = normalized()
        }
        /// Each page once, a shown tab that is one of them, a shown 项目主页 it has.
        func normalized() -> Pane {
            var seen = Set<RecentPage>()
            let unique = tabs.filter { seen.insert($0).inserted }
            return Pane(tabs: unique, active: active.flatMap { unique.contains($0) ? $0 : nil }, home: home, homeShown: home && homeShown)
        }
        var isEmpty: Bool { tabs.isEmpty && !home }
    }
    var panes: [Pane]
    var activePane: Int

    init(panes: [Pane], activePane: Int) {
        self.panes = panes; self.activePane = activePane
        self = normalized()
    }
    private enum CodingKeys: String, CodingKey { case panes, activePane }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        panes = try values.decode([Pane].self, forKey: .panes)
        activePane = (try? values.decodeIfPresent(Int.self, forKey: .activePane)) ?? 0
        self = normalized()
    }
    func normalized() -> TabSession {
        var next = self
        next.panes = Array(panes.prefix(2)).map { $0.normalized() }
        if next.panes.isEmpty { next.panes = [Pane()] }
        next.activePane = min(max(activePane, 0), next.panes.count - 1)
        return next
    }
    var isEmpty: Bool { panes.allSatisfy(\.isEmpty) }
    var isSplit: Bool { panes.count == 2 }
}

/// A project's 底部时间轴 below the editor. Unknown modes read as 阅读顺序.
struct BottomTimelineSetting: Codable, Equatable {
    var shown: Bool
    /// `book` (阅读顺序) or `narrative` (故事时间).
    var mode: String

    init(shown: Bool, axis: StoryGraphModel.Axis) { self.shown = shown; mode = axis.rawValue }

    var axis: StoryGraphModel.Axis { StoryGraphModel.Axis(rawValue: mode) ?? .book }
}

/// A chapter's or drift's 情节规划格 dock below its prose. The height is
/// clamped on read, so a hand-edited file still opens.
struct PlotPlannerSetting: Codable, Equatable {
    static let heights: ClosedRange<Double> = 140...640
    static let defaultHeight: Double = 240
    var shown: Bool
    var height: Double

    init(shown: Bool, height: Double = PlotPlannerSetting.defaultHeight) {
        self.shown = shown
        self.height = Self.clamped(height)
    }
    private enum CodingKeys: String, CodingKey { case shown, height }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        shown = (try? values.decodeIfPresent(Bool.self, forKey: .shown)) ?? false
        height = Self.clamped((try? values.decodeIfPresent(Double.self, forKey: .height)) ?? Self.defaultHeight)
    }
    static func clamped(_ height: Double) -> Double {
        height.isFinite ? min(max(height.rounded(), heights.lowerBound), heights.upperBound) : defaultHeight
    }
}

/// 设置 of this lab install. `settings.json` and the imported font copy in
/// `fonts/` live in the lab's own data directory beside `agent/` (keyed by
/// the lab's bundle identifier), never in any user defaults domain. Every
/// change is saved at once and applied to every open editor and window.
final class LabSettingsStore {
    static let didChange = Notification.Name("LabSettingsStoreDidChange")
    /// A project's 写作计划 changed; `object` is the store, `userInfo["projectID"]` the project.
    static let writingPlanDidChange = Notification.Name("LabSettingsStoreWritingPlanDidChange")
    static let fileName = "settings.json"
    static let maximumFontBytes = 64 * 1024 * 1024
    static let fontExtensions = ["ttf", "otf"]
    /// Font files registered for this process, so each registers once.
    private static var registeredFonts: Set<URL> = []

    let directory: URL
    var fileURL: URL { directory.appendingPathComponent(Self.fileName) }
    var fontsDirectory: URL { directory.appendingPathComponent("fonts", isDirectory: true) }
    private(set) var settings: LabSettings
    /// The typography applied last, after any fallback.
    private(set) var typography = DocumentTypography.standard
    /// Why the chosen font is not in use; the system serif is used instead.
    private(set) var fontFallback: String?
    /// The last font action's result (导入, 移除, 使用), in Chinese.
    private(set) var fontNotice: (text: String, isError: Bool)?
    /// Why 设置 could not be read or saved.
    private(set) var storageMessage: String?

    init(directory: URL) {
        self.directory = directory
        settings = LabSettings()
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            settings = try JSONDecoder().decode(LabSettings.self, from: Data(contentsOf: fileURL))
        } catch {
            storageMessage = "设置文件无法读取，已使用默认设置。修改任一设置后会重新保存。"
        }
    }

    deinit { rolloverTimer?.invalidate() }

    var importedFontURL: URL? { settings.importedFont.map { fontsDirectory.appendingPathComponent($0.storedName) } }

    // MARK: Changes

    /// Changes, saves and applies. An unchanged value writes nothing; the
    /// window still refreshes (a notice may have changed).
    func update(_ change: (inout LabSettings) -> Void) {
        var next = settings
        change(&next)
        next = next.normalized()
        guard next != settings else { changed(); return }
        settings = next
        save()
        apply()
    }

    /// 还原推荐样式: the system serif at 17 pt, line height 1.5, no indent,
    /// 段间距 0.7 and 版心宽度 760. An imported font stays available.
    func resetTypesetting() {
        fontNotice = nil
        update {
            $0.fontSource = .systemSerif; $0.fontSize = 17; $0.lineHeight = 1.5; $0.paragraphIndent = .none
            $0.paragraphSpacing = 0.7; $0.columnWidth = 760
        }
    }

    /// 使用: an installed family by its name or its localized name.
    @discardableResult
    func useSystemFamily(_ raw: String) -> Bool {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            fontNotice = ("请先输入系统字体家族名称。", true); changed(); return false
        }
        guard let family = Self.installedFamily(named: name) else {
            fontNotice = ("找不到已安装的字体“\(name)”。请确认名称，或从列表中选择。", true); changed(); return false
        }
        fontNotice = ("已切换到系统字体“\(family)”。", false)
        if settings.fontSource == .systemCustom, settings.systemFontFamily == family { changed(); return true }
        update { $0.systemFontFamily = family; $0.fontSource = .systemCustom }
        return true
    }

    static func installedFamily(named name: String) -> String? {
        let manager = NSFontManager.shared
        let families = manager.availableFontFamilies
        if families.contains(name) { return name }
        return families.first { $0.caseInsensitiveCompare(name) == .orderedSame || manager.localizedName(forFamily: $0, face: nil) == name }
    }

    /// 导入字体: validates a TTF or OTF file, keeps a copy in `fonts/`,
    /// registers it for this process only and uses it for prose. The
    /// previous imported copy is removed. Refusals change nothing.
    @discardableResult
    func importFont(from source: URL) -> Bool {
        func refuse(_ text: String) -> Bool { fontNotice = (text, true); changed(); return false }
        let ext = source.pathExtension.lowercased()
        guard Self.fontExtensions.contains(ext) else { return refuse("仅支持 TTF 或 OTF 字体文件。") }
        let values = try? source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values?.isRegularFile == true else { return refuse("找不到这个字体文件，它可能已被移动或删除。") }
        guard (values?.fileSize ?? 0) <= Self.maximumFontBytes else { return refuse("字体文件不能超过 64 MB。") }
        guard let data = try? Data(contentsOf: source) else { return refuse("无法读取这个字体文件，请确认有读取权限。") }
        guard !data.isEmpty else { return refuse("这个字体文件是空的。") }
        guard let family = Self.family(of: data) else {
            return refuse("无法解析这个字体文件，请确认它是有效的 Regular 或 Variable Font。")
        }
        let stored = "\(UUID().uuidString).\(ext)"
        let target = fontsDirectory.appendingPathComponent(stored)
        do {
            try FileManager.default.createDirectory(at: fontsDirectory, withIntermediateDirectories: true)
            try data.write(to: target, options: .atomic)
        } catch {
            return refuse("无法访问本地字体存储，请重启应用后重试。")
        }
        // The previous copy steps aside first: the same font imported again
        // would otherwise clash with its own registration.
        let previous = importedFontURL
        if let previous { Self.unregister(previous) }
        guard Self.register(target), Self.family(ofFile: target) == family else {
            Self.unregister(target)
            try? FileManager.default.removeItem(at: target)
            if let previous { _ = Self.register(previous) }
            return refuse("无法解析这个字体文件，请确认它是有效的 Regular 或 Variable Font。")
        }
        if let previous { try? FileManager.default.removeItem(at: previous) }
        fontNotice = ("字体已保存在本机并应用到创作内容。", false)
        update {
            $0.importedFont = LabSettings.ImportedFont(fileName: source.lastPathComponent, storedName: stored,
                                                       family: family, byteLength: data.count)
            $0.fontSource = .imported
        }
        return true
    }

    /// 移除: deletes the stored copy; prose that used it returns to the system serif.
    func removeImportedFont() {
        guard let url = importedFontURL else { return }
        Self.unregister(url)
        try? FileManager.default.removeItem(at: url)
        fontNotice = ("已移除应用内保存的字体副本。", false)
        update {
            $0.importedFont = nil
            if $0.fontSource == .imported { $0.fontSource = .systemSerif }
        }
    }

    // MARK: 便笺栏

    /// A page's pinned notes and TODOs, if any.
    func stickyNotes(projectID: String, page: String) -> StickyNotePage? { settings.stickyNotes[projectID]?[page] }

    /// Saves a page's 便笺栏 at once (nothing pinned removes the entry); an
    /// unchanged one writes nothing. Editors and the settings window are not told.
    func setStickyNotes(_ notes: StickyNotePage?, projectID: String, page: String) {
        let value = notes.map { $0.normalized() }.flatMap { $0.pinned.isEmpty ? nil : $0 }
        guard stickyNotes(projectID: projectID, page: page) != value else { return }
        var pages = settings.stickyNotes[projectID] ?? [:]
        pages[page] = value
        settings.stickyNotes[projectID] = pages.isEmpty ? nil : pages
        save()
    }

    // MARK: 大纲轨道

    /// Whether pages of the kind show their 大纲轨道 (shown unless hidden).
    func outlineRailShown(kind: String) -> Bool { settings.outlineRails[kind] ?? true }

    /// Saves the choice at once; an unchanged one writes nothing. Editors and
    /// the settings window are not told.
    func setOutlineRail(_ shown: Bool, kind: String) {
        guard LabSettings.railKinds.contains(kind), outlineRailShown(kind: kind) != shown else { return }
        settings.outlineRails[kind] = shown ? nil : false
        save()
    }

    // MARK: Element overview

    /// Where the project's 设定总览 was last left, if anywhere.
    func elementOverviewViewport(projectID: String) -> ElementOverviewViewport? { settings.elementOverviewViewports[projectID] }

    /// Saves the viewport when the panel closes; an unchanged viewport
    /// writes nothing. Editors and the settings window are not told.
    func setElementOverviewViewport(_ viewport: ElementOverviewViewport, projectID: String) {
        guard settings.elementOverviewViewports[projectID] != viewport else { return }
        settings.elementOverviewViewports[projectID] = viewport
        save()
    }

    // MARK: Bottom timeline

    /// Whether the project's 底部时间轴 was left shown, and in which mode.
    func bottomTimeline(projectID: String) -> BottomTimelineSetting? { settings.bottomTimelines[projectID] }

    /// Saves the dock's state at once; an unchanged state writes nothing.
    /// Editors and the settings window are not told.
    func setBottomTimeline(_ setting: BottomTimelineSetting, projectID: String) {
        guard settings.bottomTimelines[projectID] != setting else { return }
        settings.bottomTimelines[projectID] = setting
        save()
    }

    // MARK: 情节规划格

    /// Whether the page's 情节规划格 was left shown, and its height.
    func plotPlanner(projectID: String, nodeID: String) -> PlotPlannerSetting? { settings.plotPlanners[projectID]?[nodeID] }

    /// Saves the dock's state at once; an unchanged state writes nothing.
    /// Editors and the settings window are not told.
    func setPlotPlanner(_ setting: PlotPlannerSetting, projectID: String, nodeID: String) {
        guard plotPlanner(projectID: projectID, nodeID: nodeID) != setting else { return }
        settings.plotPlanners[projectID, default: [:]][nodeID] = setting
        save()
    }

    /// A purged chapter or drift leaves no dock state behind.
    func forgetPlotPlanner(projectID: String, nodeID: String) {
        guard settings.plotPlanners[projectID]?[nodeID] != nil else { return }
        settings.plotPlanners[projectID]?.removeValue(forKey: nodeID)
        if settings.plotPlanners[projectID]?.isEmpty == true { settings.plotPlanners.removeValue(forKey: projectID) }
        save()
    }

    // MARK: Writing plan

    /// The project's 写作计划, or the defaults (120,000 字, 1,500 字 a day).
    func writingPlan(projectID: String) -> WritingPlan { settings.writingPlans[projectID] ?? WritingPlan() }

    /// Saves the project's plan at once. An unchanged plan writes nothing.
    /// Typesetting is not applied again; open editors are untouched.
    func setWritingPlan(_ plan: WritingPlan, projectID: String) {
        guard writingPlan(projectID: projectID) != plan else { return }
        settings.writingPlans[projectID] = plan
        save()
        NotificationCenter.default.post(name: Self.writingPlanDidChange, object: self, userInfo: ["projectID": projectID])
        changed()
    }

    // MARK: Copilot

    /// 设置 › Copilot（实验） changed; `object` is the store.
    static let copilotDidChange = Notification.Name("LabSettingsStoreCopilotDidChange")

    /// Changes and saves Copilot's settings at once; an unchanged value
    /// writes nothing. Typesetting is not applied again.
    func setCopilot(_ change: (inout CopilotSettings) -> Void) {
        var next = settings.copilot
        change(&next)
        next = next.normalized()
        guard next != settings.copilot else { changed(); return }
        settings.copilot = next
        save()
        NotificationCenter.default.post(name: Self.copilotDidChange, object: self)
        changed()
    }

    // MARK: MCP 扩展

    /// A project's MCP servers changed; `object` is the store, `userInfo["projectID"]` the project.
    static let mcpDidChange = Notification.Name("LabSettingsStoreMcpDidChange")

    /// The project's MCP servers, in the order shown.
    func mcpServers(projectID: String) -> [AgentMcpServerConfig] { settings.mcpServers[projectID] ?? [] }

    /// Saves the project's servers at once; an unchanged list writes
    /// nothing. Typesetting is not applied again.
    func setMcpServers(_ servers: [AgentMcpServerConfig], projectID: String) {
        guard mcpServers(projectID: projectID) != servers else { return }
        settings.mcpServers[projectID] = servers.isEmpty ? nil : servers
        save()
        NotificationCenter.default.post(name: Self.mcpDidChange, object: self, userInfo: ["projectID": projectID])
        changed()
    }

    // MARK: Shortcuts

    /// 设置 › 快捷键 changed; `object` is the store. Menus apply it at once.
    static let shortcutsDidChange = Notification.Name("LabSettingsStoreShortcutsDidChange")

    /// Saves a command's shortcut; nil, or its default, removes the
    /// override. The caller checks the rules first (`MacShortcuts`).
    /// Typesetting is not applied again.
    func setShortcut(_ shortcut: MenuShortcut?, for command: MacMenuCommand) {
        var next = settings.shortcuts
        if let shortcut, shortcut != command.defaultShortcut { next[command.rawValue] = shortcut }
        else { next.removeValue(forKey: command.rawValue) }
        setShortcuts(next)
    }

    /// 全部还原: every command of this menu returns to its default.
    func resetAllShortcuts() {
        setShortcuts(settings.shortcuts.filter { MacMenuCommand(rawValue: $0.key) == nil })
    }

    private func setShortcuts(_ next: [String: MenuShortcut]) {
        guard next != settings.shortcuts else { changed(); return }
        settings.shortcuts = next
        save()
        NotificationCenter.default.post(name: Self.shortcutsDidChange, object: self)
        changed()
    }

    // MARK: Today's words

    /// A project's 今日字数 changed, or the local day rolled over; `object`
    /// is the store, `userInfo["projectID"]` the project (absent on rollover).
    static let dailyWordsDidChange = Notification.Name("LabSettingsStoreDailyWordsDidChange")
    /// Days kept, today included: a whole calendar month for 项目主页 › 本月.
    static let dailyWordDays = 31
    /// The clock the ledger's days follow; acceptance injects one and then
    /// calls `checkDay()`, as the midnight timer does.
    var now: () -> Date = Date.init
    /// Local calendar days.
    var calendar = Calendar.current
    /// When the next local midnight fires `checkDay()`.
    private(set) var nextRollover: Date?
    private var rolloverTimer: Timer?
    private var shownDay: String?

    /// `yyyy-MM-dd` of the local calendar day of `date`.
    func dayKey(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// The net words this device wrote in the project today; 0 for none.
    func todayWords(projectID: String) -> Int {
        if rolloverTimer == nil { scheduleRollover() }
        return settings.dailyWords[projectID]?[dayKey(now())] ?? 0
    }

    /// The stored days of a project, for acceptance and diagnostics.
    func dailyWords(projectID: String) -> [String: Int] { settings.dailyWords[projectID] ?? [:] }

    /// Adds a net change to today's entry, drops days older than 30 and
    /// saves at once. Editors and the settings window are not told.
    func recordWords(_ delta: Int, projectID: String) {
        guard delta != 0 else { return }
        let today = dayKey(now())
        settings.dailyWords[projectID, default: [:]][today, default: 0] += delta
        pruneDailyWords()
        save()
        if rolloverTimer == nil { scheduleRollover() }
        NotificationCenter.default.post(name: Self.dailyWordsDidChange, object: self, userInfo: ["projectID": projectID])
    }

    /// At local midnight: today's words start again from 0 and days beyond
    /// the 31 kept are dropped. Views showing 今日 read again.
    func checkDay() {
        let today = dayKey(now())
        if shownDay != today {
            shownDay = today
            if pruneDailyWords() { save() }
            NotificationCenter.default.post(name: Self.dailyWordsDidChange, object: self)
        }
        scheduleRollover()
    }

    /// Drops days older than the kept ones; a run of written days that
    /// reaches the dropped edge carries its length in `dailyStreaks`.
    @discardableResult
    private func pruneDailyWords() -> Bool {
        let start = calendar.startOfDay(for: now())
        guard let first = calendar.date(byAdding: .day, value: -(Self.dailyWordDays - 1), to: start) else { return false }
        let oldest = dayKey(first)
        var pruned = false
        for (projectID, days) in settings.dailyWords {
            let kept = days.filter { $0.key >= oldest }
            guard kept.count != days.count else { continue }
            pruned = true
            var carry = settings.dailyStreaks[projectID]
            for (day, words) in days.filter({ $0.key < oldest }).sorted(by: { $0.key < $1.key }) {
                if words > 0 {
                    let continues = carry.map { dayKey(offset: 1, from: $0.through) == day } ?? false
                    carry = DailyStreakCarry(through: day, days: continues ? (carry?.days ?? 0) + 1 : 1)
                } else {
                    carry = nil
                }
            }
            settings.dailyStreaks[projectID] = carry
            settings.dailyWords[projectID] = kept.isEmpty ? nil : kept
        }
        return pruned
    }

    /// The `yyyy-MM-dd` `offset` local days from another one.
    func dayKey(offset: Int, from key: String) -> String? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)),
              let moved = calendar.date(byAdding: .day, value: offset, to: date) else { return nil }
        return dayKey(moved)
    }

    /// The run of written days carried beyond the kept ones, for 连续天数.
    func dailyStreak(projectID: String) -> DailyStreakCarry? { settings.dailyStreaks[projectID] }

    private func scheduleRollover() {
        rolloverTimer?.invalidate()
        let current = now()
        if shownDay == nil { shownDay = dayKey(current) }
        guard let midnight = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: current)) else { return }
        nextRollover = midnight
        // A little past midnight, so the new day has begun on any clock.
        let timer = Timer(timeInterval: max(1, midnight.timeIntervalSince(current) + 1), repeats: false) { [weak self] _ in
            self?.checkDay()
        }
        RunLoop.main.add(timer, forMode: .common)
        rolloverTimer = timer
    }

    // MARK: Recent pages

    /// A project's 最近 changed; `object` is the store, `userInfo["projectID"]` the project.
    static let recentPagesDidChange = Notification.Name("LabSettingsStoreRecentPagesDidChange")
    /// Pages kept per project.
    static let recentPageLimit = 10

    /// The project's recent pages, newest first; some may be trashed or gone.
    func recentPages(projectID: String) -> [RecentPage] { settings.recentPages[projectID] ?? [] }

    /// A page was opened: it moves to the front (once) and the list keeps
    /// the newest ten. Saved at once; typesetting is not applied again.
    func recordRecentPage(_ page: RecentPage, projectID: String) {
        let current = recentPages(projectID: projectID)
        let next = Array(([page] + current.filter { $0 != page }).prefix(Self.recentPageLimit))
        guard next != current else { return }
        settings.recentPages[projectID] = next
        save()
        NotificationCenter.default.post(name: Self.recentPagesDidChange, object: self, userInfo: ["projectID": projectID])
    }

    /// Purged pages leave the list; trashed ones stay, hidden until restored.
    func forgetRecentPages(ids: Set<String>, projectID: String) {
        let current = recentPages(projectID: projectID)
        let next = current.filter { !ids.contains($0.id) }
        guard next != current else { return }
        settings.recentPages[projectID] = next.isEmpty ? nil : next
        save()
        NotificationCenter.default.post(name: Self.recentPagesDidChange, object: self, userInfo: ["projectID": projectID])
    }

    // MARK: Tabs

    /// The project's tabs as they were left, if any.
    func tabSession(projectID: String) -> TabSession? { settings.tabSessions[projectID] }

    /// Saves the project's tabs; an empty session removes the entry and an
    /// unchanged one writes nothing. Editors and the settings window are not told.
    func setTabSession(_ session: TabSession?, projectID: String) {
        let next = session.flatMap { $0.isEmpty ? nil : $0.normalized() }
        guard settings.tabSessions[projectID] != next else { return }
        settings.tabSessions[projectID] = next
        save()
    }

    /// The project selected last, which opens at launch.
    var lastProject: String? { settings.lastProject }

    func setLastProject(_ projectID: String?) {
        guard settings.lastProject != projectID else { return }
        settings.lastProject = projectID
        save()
    }

    // MARK: List filters

    /// A storyline or category page's list filter; nil is 全部.
    func listFilter(projectID: String, page: String) -> String? { settings.listFilters[projectID]?[page] }

    /// Saves a page's filter; 全部 (or nil) removes the entry and an unchanged
    /// one writes nothing. Editors and the settings window are not told.
    func setListFilter(_ filter: String?, projectID: String, page: String) {
        let value = filter.flatMap { ListFilter.known($0) && $0 != ListFilter.all ? $0 : nil }
        guard settings.listFilters[projectID]?[page] != value else { return }
        var pages = settings.listFilters[projectID] ?? [:]
        pages[page] = value
        settings.listFilters[projectID] = pages.isEmpty ? nil : pages
        save()
    }

    // MARK: 全书长卷 position

    func wholeBookPosition(projectID: String) -> WholeBookPosition? { settings.wholeBookPositions[projectID] }

    /// Saves where the 全书长卷 is read; an unchanged position writes nothing.
    func setWholeBookPosition(_ position: WholeBookPosition?, projectID: String) {
        guard settings.wholeBookPositions[projectID] != position else { return }
        settings.wholeBookPositions[projectID] = position
        save()
    }

    // MARK: Deleted projects

    /// A deleted project leaves no 写作计划, 设定总览 viewport, 今日字数,
    /// 底部时间轴 or 情节规划格 state, recent pages, tabs, list filters, 全书长卷
    /// position, 便笺栏 or MCP servers
    /// behind, nor stays the project that opens at launch (their Keychain
    /// secrets are removed by the caller).
    func forgetProject(_ projectID: String) {
        guard settings.writingPlans[projectID] != nil || settings.elementOverviewViewports[projectID] != nil
            || settings.dailyWords[projectID] != nil || settings.dailyStreaks[projectID] != nil
            || settings.bottomTimelines[projectID] != nil
            || settings.plotPlanners[projectID] != nil || settings.mcpServers[projectID] != nil
            || settings.recentPages[projectID] != nil || settings.tabSessions[projectID] != nil
            || settings.listFilters[projectID] != nil || settings.wholeBookPositions[projectID] != nil
            || settings.stickyNotes[projectID] != nil
            || settings.lastProject == projectID else { return }
        settings.stickyNotes.removeValue(forKey: projectID)
        settings.listFilters.removeValue(forKey: projectID)
        settings.wholeBookPositions.removeValue(forKey: projectID)
        settings.tabSessions.removeValue(forKey: projectID)
        if settings.lastProject == projectID { settings.lastProject = nil }
        settings.recentPages.removeValue(forKey: projectID)
        settings.writingPlans.removeValue(forKey: projectID)
        settings.elementOverviewViewports.removeValue(forKey: projectID)
        settings.dailyWords.removeValue(forKey: projectID)
        settings.dailyStreaks.removeValue(forKey: projectID)
        settings.bottomTimelines.removeValue(forKey: projectID)
        settings.plotPlanners.removeValue(forKey: projectID)
        settings.mcpServers.removeValue(forKey: projectID)
        save()
    }

    // MARK: Fonts

    /// The first family a font file describes, or nil when CoreText cannot read it.
    static func family(of data: Data) -> String? {
        guard let descriptors = CTFontManagerCreateFontDescriptorsFromData(data as CFData) as? [CTFontDescriptor],
              let first = descriptors.first,
              let family = CTFontDescriptorCopyAttribute(first, kCTFontFamilyNameAttribute) as? String,
              !family.isEmpty else { return nil }
        return family
    }

    /// The family of a stored font file, read from the file itself.
    static func family(ofFile url: URL) -> String? {
        guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
              let first = descriptors.first else { return nil }
        return CTFontDescriptorCopyAttribute(first, kCTFontFamilyNameAttribute) as? String
    }

    static func fontExists(family: String) -> Bool {
        NSFont(descriptor: NSFontDescriptor(fontAttributes: [.family: family]), size: 12) != nil
    }

    /// Registers a font file for this process only; nothing is installed.
    static func register(_ url: URL) -> Bool {
        let url = url.standardizedFileURL
        if registeredFonts.contains(url) { return true }
        var error: Unmanaged<CFError>?
        if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
            registeredFonts.insert(url); return true
        }
        // Already registered, or a font of that name is installed: the family resolves either way.
        let code = error.map { CFErrorGetCode($0.takeRetainedValue()) }
        if code == CTFontManagerError.alreadyRegistered.rawValue || code == CTFontManagerError.duplicatedName.rawValue {
            registeredFonts.insert(url); return true
        }
        return false
    }

    static func unregister(_ url: URL) {
        let url = url.standardizedFileURL
        guard registeredFonts.remove(url) != nil else { return }
        CTFontManagerUnregisterFontsForURL(url as CFURL, .process, nil)
    }

    // MARK: Applying

    /// The prose typography these settings describe. A missing custom family
    /// or a missing or unreadable imported font falls back to the system
    /// serif and says why.
    func resolvedTypography() -> (DocumentTypography, fallback: String?) {
        var typography = DocumentTypography()
        typography.size = CGFloat(settings.fontSize)
        typography.language = settings.languageTag
        typography.paragraphSpacing = (CGFloat(settings.paragraphSpacing) * typography.size).rounded()
        typography.paragraphIndent = typography.size * CGFloat(LabSettings.Indent.allCases.firstIndex(of: settings.paragraphIndent) ?? 0)
        var fallback: String?
        switch settings.fontSource {
        case .systemSerif: typography.face = .systemSerif
        case .systemSans: typography.face = .systemSans
        case .systemMono: typography.face = .systemMono
        case .systemCustom:
            if Self.fontExists(family: settings.systemFontFamily) {
                typography.face = .family(settings.systemFontFamily)
            } else {
                typography.face = .systemSerif
                fallback = "找不到字体“\(settings.systemFontFamily)”，已改用系统衬线字体。"
            }
        case .imported:
            if let font = settings.importedFont, let url = importedFontURL,
               FileManager.default.fileExists(atPath: url.path), Self.register(url), Self.family(ofFile: url) == font.family {
                // Set from the copy itself: a family lookup can lag a
                // registration until the run loop processes the change.
                typography.face = .file(url)
            } else {
                typography.face = .systemSerif
                fallback = "导入的字体“\(settings.importedFont?.fileName ?? "")”已丢失或无法读取，已改用系统衬线字体。请重新导入。"
            }
        }
        // Line height is a multiple of the font size, as in CSS; TextKit adds
        // the difference to the face's natural line height.
        let body = DocumentStyle.font(typography, size: typography.size, weight: .regular, italic: false, monospaced: false)
        let natural = NSLayoutManager().defaultLineHeight(for: body)
        typography.lineSpacing = max(0, (typography.size * CGFloat(settings.lineHeight) - natural).rounded())
        return (typography, fallback)
    }

    /// Applies every setting: prose typography and spelling in open editors,
    /// the theme of every window, and the accent colour.
    func apply() {
        let (typography, fallback) = resolvedTypography()
        self.typography = typography
        fontFallback = fallback
        DocumentStyle.typography = typography
        MacEditorPreferences.spellChecking = settings.spellcheck
        MacEditorPreferences.typewriterScrolling = settings.typewriterScrolling
        MacEditorPreferences.typewriterPosition = CGFloat(settings.typewriterPosition / 100)
        MacEditorPreferences.columnWidth = CGFloat(settings.columnWidth)
        DocumentStore.automaticEntityLinks = settings.autoEntityLinks
        let accent = settings.accentColor.flatMap { DocumentStyle.linkColor(hex: $0) }
        let accentChanged = accent != MacEditorPreferences.accentColor
        MacEditorPreferences.accentColor = accent
        var appearance: NSAppearance?
        switch settings.theme {
        case .light: appearance = NSAppearance(named: .aqua)
        case .dark: appearance = NSAppearance(named: .darkAqua)
        case .system: appearance = nil
        }
        let application = NSApplication.shared
        if application.appearance?.name != appearance?.name { application.appearance = appearance }
        // Washes drawn in updateLayer pick up the new accent on redraw.
        if accentChanged { for window in application.windows { window.contentView.map(Self.redraw) } }
        changed()
    }

    /// Returns the editors to their state before any settings applied.
    static func restoreUnconfigured() {
        DocumentStyle.typography = .standard
        MacEditorPreferences.spellChecking = nil
        MacEditorPreferences.accentColor = nil
        MacEditorPreferences.typewriterScrolling = nil
        MacEditorPreferences.typewriterPosition = nil
        MacEditorPreferences.columnWidth = nil
        DocumentStore.automaticEntityLinks = true
        NSApplication.shared.appearance = nil
    }

    private static func redraw(_ view: NSView) {
        view.needsDisplay = true
        view.subviews.forEach(redraw)
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(settings).write(to: fileURL, options: .atomic)
            storageMessage = nil
        } catch {
            storageMessage = "设置未能保存到本机，本次修改仍然生效：\(error.localizedDescription)"
        }
    }

    private func changed() { NotificationCenter.default.post(name: Self.didChange, object: self) }
}
