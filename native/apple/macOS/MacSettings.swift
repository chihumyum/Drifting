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
    /// Each project's 写作计划, keyed by project identity; a project without
    /// one uses the defaults.
    var writingPlans: [String: WritingPlan] = [:]
    /// Each project's 设定总览 viewport, keyed by project identity.
    var elementOverviewViewports: [String: ElementOverviewViewport] = [:]

    static let fontSizes: ClosedRange<Double> = 12...28
    static let lineHeights: ClosedRange<Double> = 1.0...2.0
    static let locales: [(code: String, name: String)] = [
        ("zh-CN", "中文（简体）"), ("zh-TW", "中文（繁體）"), ("en", "English"), ("ja", "日本語"), ("ko", "한국어"), ("fr", "Français"),
    ]

    init() {}

    private enum CodingKeys: String, CodingKey {
        case theme, accentColor, fontSource, systemFontFamily, importedFont, fontSize, lineHeight, paragraphIndent, spellcheck, manuscriptLocale
        case writingPlans, elementOverviewViewports
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
        writingPlans = (try? values.decodeIfPresent([String: WritingPlan].self, forKey: .writingPlans)) ?? [:]
        elementOverviewViewports = (try? values.decodeIfPresent([String: ElementOverviewViewport].self,
                                                                forKey: .elementOverviewViewports)) ?? [:]
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
        return next
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

    // MARK: Deleted projects

    /// A deleted project leaves no 写作计划 or 设定总览 viewport behind.
    func forgetProject(_ projectID: String) {
        guard settings.writingPlans[projectID] != nil || settings.elementOverviewViewports[projectID] != nil else { return }
        settings.writingPlans.removeValue(forKey: projectID)
        settings.elementOverviewViewports.removeValue(forKey: projectID)
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
