import Foundation
#if os(macOS)
import AppKit
private typealias PlatformFont = NSFont
typealias PlatformColor = NSColor
#else
import UIKit
private typealias PlatformFont = UIFont
typealias PlatformColor = UIColor
#endif

/// A link target as the workspace currently knows it: an element (with its
/// category colour and hover summary) or a chapter, live or in the trash.
struct EntityLinkTarget: Equatable {
    enum Kind: Equatable { case element, chapter }
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
        guard kind == .element else { return "章节 · \(name)" }
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

/// Resolves link marks against the workspace's elements and chapters.
/// Presentation only: marks stay in Yrs exactly as written.
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

    init(targets: [EntityLinkTarget]) {
        for target in targets {
            switch target.kind {
            case .element: elements[target.id] = target
            case .chapter: chapters[target.id] = target
            }
        }
    }

    /// Nil for a kind this view does not resolve; `.some(nil)` for a known
    /// kind whose target no longer exists.
    func target(for link: NativeEntityLink) -> EntityLinkTarget?? {
        switch link.kind {
        case "element": return .some(elements[link.id])
        case "node": return .some(chapters[link.id])
        default: return nil
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
    private static func fontSize(_ block: NativeBlock) -> CGFloat {
        guard block.kind == "heading" else { return 17 }
        switch block.headingLevel {
        case 1: return 28
        case 2: return 24
        default: return 20
        }
    }
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
        storage.setAttributes([.font: PlatformFont.systemFont(ofSize: 17), .foregroundColor: PlatformColor.labelColorForDocument], range: range)
        for block in blocks {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 6; paragraph.paragraphSpacing = 12
            paragraph.headIndent = CGFloat(block.depth) * 12
            paragraph.firstLineHeadIndent = paragraph.headIndent
            var base: [NSAttributedString.Key: Any] = [.paragraphStyle: paragraph]
            if block.kind == "heading" { base[.font] = PlatformFont.systemFont(ofSize: fontSize(block), weight: .semibold) }
            if block.kind == "codeBlock" { base[.font] = PlatformFont.monospacedSystemFont(ofSize: 15, weight: .regular) }
            if !block.editable { base[.foregroundColor] = PlatformColor.secondaryLabelColorForDocument }
            storage.addAttributes(base, range: block.range.nsRange)
            for run in block.runs {
                var attrs: [NSAttributedString.Key: Any] = [:]
                let size = fontSize(block)
                var font = PlatformFont.systemFont(ofSize: size,
                    weight: run.attributes.bold ? .bold : (block.kind == "heading" ? .semibold : .regular))
                if run.attributes.italic {
                    #if os(macOS)
                    font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
                    #else
                    if let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
                        font = UIFont(descriptor: descriptor, size: size)
                    }
                    #endif
                }
                if run.attributes.bold || run.attributes.italic { attrs[.font] = font }
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
