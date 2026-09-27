import Foundation
import CoreText
#if os(macOS)
import AppKit
typealias PlatformFont = NSFont
typealias PlatformColor = NSColor
#else
import UIKit
typealias PlatformFont = UIFont
typealias PlatformColor = UIColor
#endif

/// How prose is set in every body editor. 设置 changes it on the Mac; without
/// settings it is the system sans at 17 pt, as before settings existed.
struct DocumentTypography: Equatable {
    enum Face: Equatable {
        case systemSans, systemSerif, systemMono
        /// An installed family; glyphs it lacks fall back to the manuscript
        /// language's serif face.
        case family(String)
        /// An imported font file, set from the file itself; glyphs it lacks
        /// fall back as for a family.
        case file(URL)
    }
    var face: Face = .systemSans
    /// Body size in points; headings and code scale with it.
    var size: CGFloat = 17
    var lineSpacing: CGFloat = 6
    var paragraphSpacing: CGFloat = 12
    /// Extra first-line indent of top-level paragraphs, in points.
    var paragraphIndent: CGFloat = 0
    /// BCP 47 language of the manuscript (glyph forms, fallback fonts and
    /// line breaking); nil leaves it to the system.
    var language: String? = nil

    static let standard = DocumentTypography()

    /// 28, 24 and 20 pt at the 17 pt body size.
    func headingSize(_ level: Int) -> CGFloat {
        size * (level == 1 ? 28 : level == 2 ? 24 : 20) / 17
    }
    var codeSize: CGFloat { size * 15 / 17 }

    /// The serif family that sets CJK glyphs for the serif faces: Song or
    /// Ming for Chinese, Mincho for Japanese and Myeongjo for Korean.
    var cjkSerifFamily: String {
        switch language?.lowercased() ?? "" {
        case let code where code.hasPrefix("zh-hant") || code == "zh-tw" || code == "zh-hk": return "Songti TC"
        case let code where code.hasPrefix("ja"): return "Hiragino Mincho ProN"
        case let code where code.hasPrefix("ko"): return "AppleMyungjo"
        default: return "Songti SC"
        }
    }
}

/// A link target as the workspace currently knows it: an element (with its
/// category colour and hover summary), a chapter or a drift, live or in the
/// trash. Chapters and drifts are both book nodes (`node` marks).
struct EntityLinkTarget: Equatable {
    enum Kind: Equatable { case element, chapter, drift }
    let kind: Kind
    let id: String
    let name: String
    var trashed = false
    /// `#RRGGBB` of the element's live category; nil draws the default link colour.
    var colorHex: String? = nil
    var category: String? = nil
    var aliases: [String] = []
    var summary: String = ""

    /// Hover preview: name and category, up to three aliases, then the summary.
    var preview: String {
        if trashed { return "\(name)（已在回收站）" }
        if kind == .chapter { return "章节 · \(name)" }
        if kind == .drift { return "漂流 · \(name)" }
        var lines = ["\(name) · \(category ?? "未分类")"]
        if !aliases.isEmpty {
            let shown = aliases.prefix(3).joined(separator: "、")
            lines.append(aliases.count > 3 ? "别名：\(shown) 等 \(aliases.count) 个" : "别名：\(shown)")
        }
        let brief = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !brief.isEmpty { lines.append(brief) }
        return lines.joined(separator: "\n")
    }
}

/// Resolves link marks against the workspace's elements, chapters and
/// drifts. Presentation only: marks stay in Yrs exactly as written.
struct EntityLinkDirectory: Equatable {
    enum Presentation: Equatable {
        /// Styled and openable. Nil is a target this view cannot resolve
        /// (another kind, or a payload without identity): the default style.
        case live(EntityLinkTarget?)
        /// Dimmed and not openable, like the renderer's trashed links.
        case trashed(EntityLinkTarget)
        /// The target no longer exists: plain prose.
        case plain
    }
    private(set) var elements: [String: EntityLinkTarget] = [:]
    private(set) var chapters: [String: EntityLinkTarget] = [:]
    private(set) var drifts: [String: EntityLinkTarget] = [:]

    init(targets: [EntityLinkTarget]) {
        for target in targets {
            switch target.kind {
            case .element: elements[target.id] = target
            case .chapter: chapters[target.id] = target
            case .drift: drifts[target.id] = target
            }
        }
    }

    /// Nil for a kind this view does not resolve; `.some(nil)` for a known
    /// kind whose target no longer exists.
    func target(for link: NativeEntityLink) -> EntityLinkTarget?? {
        switch link.kind {
        case "element": return .some(elements[link.id])
        case "node": return .some(chapters[link.id] ?? drifts[link.id])
        default: return nil
        }
    }

    /// The directory's current entry for a target resolved earlier, e.g.
    /// when a menu item is chosen after the target was trashed.
    func current(_ target: EntityLinkTarget) -> EntityLinkTarget? {
        switch target.kind {
        case .element: return elements[target.id]
        case .chapter: return chapters[target.id]
        case .drift: return drifts[target.id]
        }
    }

    /// Live targets in mark order; trashed and missing ones are skipped.
    func liveTargets(_ links: [NativeEntityLink]) -> [EntityLinkTarget] {
        links.compactMap { link in target(for: link).flatMap { $0 }.flatMap { $0.trashed ? nil : $0 } }
    }

    func presentation(of links: [NativeEntityLink]) -> Presentation {
        guard !links.isEmpty else { return .live(nil) }
        var trashed: EntityLinkTarget?
        for link in links {
            guard let known = target(for: link) else { return .live(nil) }
            guard let target = known else { continue }
            if !target.trashed { return .live(target) }
            trashed = trashed ?? target
        }
        return trashed.map(Presentation.trashed) ?? .plain
    }
}

enum DocumentStyle {
    /// The typography every body editor uses. Main thread only; a change
    /// posts `typographyDidChange` and open editors restyle their prose.
    static var typography = DocumentTypography.standard {
        didSet {
            guard typography != oldValue else { return }
            fonts.removeAll()
            NotificationCenter.default.post(name: typographyDidChange, object: nil)
        }
    }
    static let typographyDidChange = Notification.Name("DocumentStyleTypographyDidChange")

    private struct FontKey: Hashable {
        let size: CGFloat
        let weight: CGFloat
        let italic: Bool
        let monospaced: Bool
    }
    private static var fonts: [FontKey: PlatformFont] = [:]

    /// A prose font of the current typography, cached until it changes.
    static func font(size: CGFloat, weight: PlatformFont.Weight = .regular, italic: Bool = false,
                     monospaced: Bool = false) -> PlatformFont {
        let key = FontKey(size: size, weight: weight.rawValue, italic: italic, monospaced: monospaced)
        if let font = fonts[key] { return font }
        let font = self.font(typography, size: size, weight: weight, italic: italic, monospaced: monospaced)
        fonts[key] = font
        return font
    }
    static var bodyFont: PlatformFont { font(size: typography.size) }

    /// A prose font of any typography, uncached.
    static func font(_ typography: DocumentTypography, size: CGFloat, weight: PlatformFont.Weight,
                     italic: Bool, monospaced: Bool) -> PlatformFont {
        let face = monospaced ? .systemMono : typography.face
        var font: PlatformFont
        switch face {
        case .systemSans: font = PlatformFont.systemFont(ofSize: size, weight: weight)
        case .systemMono: font = PlatformFont.monospacedSystemFont(ofSize: size, weight: weight)
        case .systemSerif:
            let system = PlatformFont.systemFont(ofSize: size, weight: weight)
            font = system.fontDescriptor.withDesign(.serif).flatMap { Self.font(descriptor: $0, size: size) } ?? system
        case .family(let family):
            #if os(macOS)
            let plain = NSFontDescriptor(fontAttributes: [.family: family])
            let bold = weight.rawValue >= PlatformFont.Weight.semibold.rawValue ? plain.withSymbolicTraits(.bold) : plain
            #else
            let plain = UIFontDescriptor(fontAttributes: [.family: family])
            let bold = weight.rawValue >= PlatformFont.Weight.semibold.rawValue
                ? (plain.withSymbolicTraits(.traitBold) ?? plain) : plain
            #endif
            font = self.font(descriptor: bold, size: size) ?? self.font(descriptor: plain, size: size)
                ?? self.font(DocumentTypography(face: .systemSerif, language: typography.language), size: size,
                             weight: weight, italic: false, monospaced: false)
        case .file(let url):
            if let descriptor = (CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor])?.first {
                font = CTFontCreateWithFontDescriptor(descriptor, size, nil) as PlatformFont
                if weight.rawValue >= PlatformFont.Weight.semibold.rawValue {
                    #if os(macOS)
                    font = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
                    #else
                    if let bold = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitBold)) {
                        font = UIFont(descriptor: bold, size: size)
                    }
                    #endif
                }
            } else {
                font = self.font(DocumentTypography(face: .systemSerif, language: typography.language), size: size,
                                 weight: weight, italic: false, monospaced: false)
            }
        }
        if italic {
            #if os(macOS)
            font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
            #else
            if let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
                font = UIFont(descriptor: descriptor, size: size)
            }
            #endif
        }
        // Serif faces set CJK glyphs in the language's serif family, at the
        // same weight, instead of the system's sans fallback.
        switch face {
        case .systemSerif, .family, .file:
            #if os(macOS)
            let cjk = NSFontDescriptor(fontAttributes: [.family: typography.cjkSerifFamily])
            let cascade = weight.rawValue >= PlatformFont.Weight.semibold.rawValue ? cjk.withSymbolicTraits(.bold) : cjk
            #else
            let cjk = UIFontDescriptor(fontAttributes: [.family: typography.cjkSerifFamily])
            let cascade = weight.rawValue >= PlatformFont.Weight.semibold.rawValue ? (cjk.withSymbolicTraits(.traitBold) ?? cjk) : cjk
            #endif
            font = self.font(descriptor: font.fontDescriptor.addingAttributes([.cascadeList: [cascade]]), size: size) ?? font
        case .systemSans, .systemMono: break
        }
        return font
    }

    #if os(macOS)
    private static func font(descriptor: NSFontDescriptor, size: CGFloat) -> NSFont? { NSFont(descriptor: descriptor, size: size) }
    #else
    private static func font(descriptor: UIFontDescriptor, size: CGFloat) -> UIFont? { UIFont(descriptor: descriptor, size: size) }
    #endif

    private static func fontSize(_ block: NativeBlock) -> CGFloat {
        guard block.kind == "heading" else { return typography.size }
        return typography.headingSize(block.headingLevel)
    }

    /// The paragraph style of a block under the current typography.
    static func paragraphStyle(kind: String, depth: Int) -> NSParagraphStyle {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = typography.lineSpacing; paragraph.paragraphSpacing = typography.paragraphSpacing
        paragraph.headIndent = CGFloat(depth) * 12
        paragraph.firstLineHeadIndent = paragraph.headIndent + (kind == "paragraph" && depth == 0 ? typography.paragraphIndent : 0)
        return paragraph
    }

    /// Plain body text as editors set it: the settings preview uses this.
    static var bodyAttributes: [NSAttributedString.Key: Any] {
        var attributes: [NSAttributedString.Key: Any] = [.font: bodyFont, .foregroundColor: PlatformColor.labelColorForDocument,
                                                         .paragraphStyle: paragraphStyle(kind: "paragraph", depth: 0)]
        if let language = typography.language { attributes[languageKey] = language }
        return attributes
    }

    /// CoreText's language attribute: glyph forms, fallback fonts and line breaking.
    static let languageKey = NSAttributedString.Key(kCTLanguageAttributeName as String)
    enum Update: Equatable {
        case unchanged
        case block(Int)
        case full
    }

    /// Only a TextKit edit already present in storage may reuse shifted styles.
    /// Structural edits and replacement of the entire string keep the full path.
    @discardableResult
    static func update(_ projection: NativeProjection, previous: NativeProjection?,
                       localChange: NativeTextChange?, to storage: NSTextStorage,
                       links: EntityLinkDirectory? = nil) -> Update {
        if let previous {
            if NativeText.identical(previous.text, projection.text) && sameDisplay(previous, projection) { return .unchanged }
            if let localChange, let index = localBlock(previous, projection, change: localChange) {
                let block = projection.blocks[index]
                let end = NSMaxRange(block.range.nsRange)
                // The separator has the default font/color, even after a heading.
                let separator = end < storage.length && (projection.text as NSString).character(at: end) == 10 ? 1 : 0
                let range = NSRange(location: block.range.location, length: block.range.length + separator)
                apply(projection, to: storage, range: range, blocks: [block], links: links)
                return .block(index)
            }
        }
        apply(projection, to: storage, links: links)
        return .full
    }

    /// Without a directory every link keeps the default link style.
    static func apply(_ projection: NativeProjection, to storage: NSTextStorage, links: EntityLinkDirectory? = nil) {
        apply(projection, to: storage, range: NSRange(location: 0, length: storage.length), blocks: projection.blocks, links: links)
    }

    /// `#RRGGBB` as an sRGB colour, or nil for a value this view cannot draw.
    static func linkColor(hex color: String) -> PlatformColor? {
        let hex = color.hasPrefix("#") ? String(color.dropFirst()) : color
        guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        let red = CGFloat((value >> 16) & 0xFF) / 255, green = CGFloat((value >> 8) & 0xFF) / 255, blue = CGFloat(value & 0xFF) / 255
        #if os(macOS)
        return NSColor(srgbRed: red, green: green, blue: blue, alpha: 1)
        #else
        return UIColor(red: red, green: green, blue: blue, alpha: 1)
        #endif
    }

    /// Element links take their category colour, chapter links the default
    /// blue; trashed targets are dimmed without underline; missing ones are
    /// plain prose.
    private static func linkAttributes(_ marks: NativeMarks, links: EntityLinkDirectory?) -> [NSAttributedString.Key: Any] {
        switch links?.presentation(of: marks.links) ?? .live(nil) {
        case .live(let target):
            return [.foregroundColor: target?.colorHex.flatMap { linkColor(hex: $0) } ?? PlatformColor.systemBlue,
                    .underlineStyle: NSUnderlineStyle.single.rawValue]
        case .trashed: return [.foregroundColor: PlatformColor.secondaryLabelColorForDocument]
        case .plain: return [:]
        }
    }

    private static func apply(_ projection: NativeProjection, to storage: NSTextStorage,
                              range: NSRange, blocks: [NativeBlock], links: EntityLinkDirectory?) {
        storage.beginEditing()
        var plain: [NSAttributedString.Key: Any] = [.font: bodyFont, .foregroundColor: PlatformColor.labelColorForDocument]
        if let language = typography.language { plain[languageKey] = language }
        storage.setAttributes(plain, range: range)
        for block in blocks {
            var base: [NSAttributedString.Key: Any] = [.paragraphStyle: paragraphStyle(kind: block.kind, depth: block.depth)]
            if block.kind == "heading" { base[.font] = font(size: fontSize(block), weight: .semibold) }
            if block.kind == "codeBlock" { base[.font] = font(size: typography.codeSize, monospaced: true) }
            if !block.editable { base[.foregroundColor] = PlatformColor.secondaryLabelColorForDocument }
            storage.addAttributes(base, range: block.range.nsRange)
            for run in block.runs {
                var attrs: [NSAttributedString.Key: Any] = [:]
                if run.attributes.bold || run.attributes.italic {
                    attrs[.font] = font(size: fontSize(block),
                        weight: run.attributes.bold ? .bold : (block.kind == "heading" ? .semibold : .regular),
                        italic: run.attributes.italic)
                }
                if run.attributes.strike { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                if run.attributes.entityLink { attrs.merge(linkAttributes(run.attributes, links: links)) { _, new in new } }
                storage.addAttributes(attrs, range: run.range.nsRange)
            }
        }
        for comment in projection.comments {
            for highlight in comment.ranges where highlight.location >= 0 && highlight.length > 0
                && highlight.location <= storage.length && highlight.length <= storage.length - highlight.location {
                let intersection = NSIntersectionRange(highlight.nsRange, range)
                if intersection.length > 0 {
                    storage.addAttribute(.backgroundColor, value: PlatformColor.systemYellow.withAlphaComponent(0.22), range: intersection)
                }
            }
        }
        storage.endEditing()
    }

    private static func sameMarks(_ left: NativeMarks, _ right: NativeMarks) -> Bool {
        left.bold == right.bold && left.italic == right.italic
            && left.entityLink == right.entityLink && left.strike == right.strike && left.links == right.links
    }

    private static func sameBlock(_ left: NativeBlock, _ right: NativeBlock) -> Bool {
        left.id == right.id && left.kind == right.kind && left.depth == right.depth
            && left.container == right.container && left.editable == right.editable
            && left.structuralAttributes == right.structuralAttributes
            && left.headingLevel == right.headingLevel
    }

    private static func sameRuns(_ left: [NativeRun], _ right: [NativeRun], offset: Int = 0) -> Bool {
        left.count == right.count && zip(left, right).allSatisfy { old, new in
            old.range.location + offset == new.range.location && old.range.length == new.range.length
                && sameMarks(old.attributes, new.attributes)
        }
    }

    private static func sameComments(_ left: [NativeComment], _ right: [NativeComment], change: NativeTextChange? = nil) -> Bool {
        left.count == right.count && zip(left, right).allSatisfy { old, new in
            old.ranges.count == new.ranges.count && zip(old.ranges, new.ranges).allSatisfy { before, after in
                (change?.mapSelection(before.nsRange) ?? before.nsRange) == after.nsRange
            }
        }
    }

    private static func sameDisplay(_ left: NativeProjection, _ right: NativeProjection) -> Bool {
        left.blocks.count == right.blocks.count && zip(left.blocks, right.blocks).allSatisfy { old, new in
            sameBlock(old, new) && old.range.nsRange == new.range.nsRange && sameRuns(old.runs, new.runs)
        } && sameComments(left.comments, right.comments)
    }

    private static func localBlock(_ before: NativeProjection, _ after: NativeProjection, change: NativeTextChange) -> Int? {
        let oldText = before.text as NSString
        guard change.range.location >= 0, change.range.length >= 0,
              change.range.location <= oldText.length, change.range.length <= oldText.length - change.range.location,
              NativeText.identical(change.target, after.text),
              NativeText.identical(oldText.replacingCharacters(in: change.range, with: change.text), after.text),
              !change.text.contains(where: isSeparator),
              !oldText.substring(with: change.range).contains(where: isSeparator),
              before.blocks.count == after.blocks.count,
              let index = NativeLayout.index(change.range.location, blocks: before.blocks),
              NativeLayout.index(NSMaxRange(change.range), blocks: before.blocks) == index,
              before.blocks[index].editable, before.blocks[index].range.length > 0,
              after.blocks[index].range.length > 0,
              sameComments(before.comments, after.comments, change: change) else { return nil }
        let delta = (change.text as NSString).length - change.range.length
        for at in before.blocks.indices {
            let old = before.blocks[at], new = after.blocks[at]
            let offset = at > index ? delta : 0
            guard sameBlock(old, new), old.range.location + offset == new.range.location,
                  old.range.length + (at == index ? delta : 0) == new.range.length,
                  at == index || sameRuns(old.runs, new.runs, offset: offset) else { return nil }
        }
        return index
    }

    private static func isSeparator(_ character: Character) -> Bool {
        character == "\n" || character == "\r" || character == "\r\n" || character == "\u{2028}" || character == "\u{2029}"
    }
}

private extension PlatformColor {
    static var labelColorForDocument: PlatformColor {
        #if os(macOS)
        return .labelColor
        #else
        return .label
        #endif
    }
    static var secondaryLabelColorForDocument: PlatformColor {
        #if os(macOS)
        return .secondaryLabelColor
        #else
        return .secondaryLabel
        #endif
    }
}
