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
    private static func post() { NotificationCenter.default.post(name: didChange, object: nil) }
}

extension NSColor {
    /// The 界面强调色 chosen in 设置, else the system accent colour. Washes
    /// and highlights draw with it; the insertion point never does.
    static var labAccent: NSColor { MacEditorPreferences.accentColor ?? .controlAccentColor }
}

/// What 设置 stores: appearance, editor typesetting and language. Values are
/// clamped on read, so a hand-edited or older file still opens.
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
    /// 打字机滚动 (off by default): the caret line stays about 40% down.
    var typewriterScrolling = false
    /// Each project's 写作计划, keyed by project identity; a project without
    /// one uses the defaults.
    var writingPlans: [String: WritingPlan] = [:]
    /// Each project's 设定总览 viewport, keyed by project identity.
    var elementOverviewViewports: [String: ElementOverviewViewport] = [:]
    /// 今日字数: per project, the net change in canonical chapter word
    /// counts this device's own saves made on each local calendar day
    /// (`yyyy-MM-dd`), for the last 30 days. See `DailyWordLedger`.
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

    static let fontSizes: ClosedRange<Double> = 12...28
    static let lineHeights: ClosedRange<Double> = 1.0...2.0
    static let locales: [(code: String, name: String)] = [
        ("zh-CN", "中文（简体）"), ("zh-TW", "中文（繁體）"), ("en", "English"), ("ja", "日本語"), ("ko", "한국어"), ("fr", "Français"),
    ]

    init() {}

    private enum CodingKeys: String, CodingKey {
        case theme, accentColor, fontSource, systemFontFamily, importedFont, fontSize, lineHeight, paragraphIndent, spellcheck, manuscriptLocale
        case typewriterScrolling
        case writingPlans, elementOverviewViewports, dailyWords, bottomTimelines, plotPlanners, copilot, mcpServers, shortcuts
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
        writingPlans = (try? values.decodeIfPresent([String: WritingPlan].self, forKey: .writingPlans)) ?? [:]
        elementOverviewViewports = (try? values.decodeIfPresent([String: ElementOverviewViewport].self,
                                                                forKey: .elementOverviewViewports)) ?? [:]
        dailyWords = (try? values.decodeIfPresent([String: [String: Int]].self, forKey: .dailyWords)) ?? [:]
        bottomTimelines = (try? values.decodeIfPresent([String: BottomTimelineSetting].self, forKey: .bottomTimelines)) ?? [:]
        plotPlanners = (try? values.decodeIfPresent([String: [String: PlotPlannerSetting]].self, forKey: .plotPlanners)) ?? [:]
        copilot = (try? values.decodeIfPresent(CopilotSettings.self, forKey: .copilot)) ?? CopilotSettings()
        mcpServers = (try? values.decodeIfPresent([String: [AgentMcpServerConfig]].self, forKey: .mcpServers)) ?? [:]
        // One unreadable shortcut does not take the others with it.
        let shortcutValues = (try? values.decodeIfPresent([String: LenientShortcut].self, forKey: .shortcuts)) ?? [:]
        shortcuts = shortcutValues.compactMapValues(\.value)
        self = normalized()
    }

    func normalized() -> LabSettings {
        var next = self
        next.fontSize = min(max(fontSize.isFinite ? fontSize.rounded() : 17, Self.fontSizes.lowerBound), Self.fontSizes.upperBound)
        next.lineHeight = min(max(lineHeight.isFinite ? (lineHeight * 100).rounded() / 100 : 1.5, Self.lineHeights.lowerBound),
                              Self.lineHeights.upperBound)
        next.systemFontFamily = String(systemFontFamily.trimmingCharacters(in: .whitespacesAndNewlines).prefix(128))
        if let accent = accentColor, DocumentStyle.linkColor(hex: accent) == nil { next.accentColor = nil }
        if !Self.locales.contains(where: { $0.code == manuscriptLocale }) { next.manuscriptLocale = "zh-CN" }
        if next.fontSource == .systemCustom, next.systemFontFamily.isEmpty { next.fontSource = .systemSerif }
        if next.fontSource == .imported, next.importedFont == nil { next.fontSource = .systemSerif }
        next.copilot = copilot.normalized()
        // A shortcut no command may take (no ⌘ or ⌃, or reserved by the
        // system) is dropped; the command keeps its default.
        next.shortcuts = shortcuts.filter { MacShortcuts.refusal($0.value) == nil }
        return next
    }

    private struct LenientShortcut: Decodable {
        let value: MenuShortcut?
        init(from decoder: Decoder) throws { value = try? MenuShortcut(from: decoder) }
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

    /// 还原推荐样式: the system serif at 17 pt, line height 1.5, no indent.
    /// An imported font stays available.
    func resetTypesetting() {
        fontNotice = nil
        update {
            $0.fontSource = .systemSerif; $0.fontSize = 17; $0.lineHeight = 1.5; $0.paragraphIndent = .none
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
    /// Days kept, today included.
    static let dailyWordDays = 30
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
    /// the 30 kept are dropped. Views showing 今日 read again.
    func checkDay() {
        let today = dayKey(now())
        if shownDay != today {
            shownDay = today
            if pruneDailyWords() { save() }
            NotificationCenter.default.post(name: Self.dailyWordsDidChange, object: self)
        }
        scheduleRollover()
    }

    @discardableResult
    private func pruneDailyWords() -> Bool {
        let start = calendar.startOfDay(for: now())
        guard let first = calendar.date(byAdding: .day, value: -(Self.dailyWordDays - 1), to: start) else { return false }
        let oldest = dayKey(first)
        var pruned = false
        for (projectID, days) in settings.dailyWords {
            let kept = days.filter { $0.key >= oldest }
            if kept.count != days.count { pruned = true; settings.dailyWords[projectID] = kept.isEmpty ? nil : kept }
        }
        return pruned
    }

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

    // MARK: Deleted projects

    /// A deleted project leaves no 写作计划, 设定总览 viewport, 今日字数,
    /// 底部时间轴 or 情节规划格 state or MCP servers behind (their Keychain secrets are
    /// removed by the caller).
    func forgetProject(_ projectID: String) {
        guard settings.writingPlans[projectID] != nil || settings.elementOverviewViewports[projectID] != nil
            || settings.dailyWords[projectID] != nil || settings.bottomTimelines[projectID] != nil
            || settings.plotPlanners[projectID] != nil || settings.mcpServers[projectID] != nil else { return }
        settings.writingPlans.removeValue(forKey: projectID)
        settings.elementOverviewViewports.removeValue(forKey: projectID)
        settings.dailyWords.removeValue(forKey: projectID)
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
        typography.paragraphSpacing = (12 * typography.size / 17).rounded()
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
